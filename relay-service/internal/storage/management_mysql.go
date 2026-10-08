package storage

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"time"

	"agents-team-relay/internal/logx"
	"github.com/go-sql-driver/mysql"
)

// migrateManagement 增量创建后台发布表与统计索引。参数：ctx控制超时；返回值：DDL错误；注意事项：不改变已有账号数据，已存在索引先校验列定义，不重复执行DDL。
func (s *MySQL) migrateManagement(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS app_releases (
 id CHAR(36) NOT NULL PRIMARY KEY, platform VARCHAR(16) NOT NULL, arch VARCHAR(16) NOT NULL,
 version VARCHAR(64) NOT NULL, build_number BIGINT NOT NULL, notes TEXT NOT NULL,
 file_name VARCHAR(200) NOT NULL, file_size BIGINT NOT NULL, sha256 CHAR(64) NOT NULL,
 storage_key VARCHAR(100) NOT NULL, status VARCHAR(16) NOT NULL, created_by VARCHAR(320) NOT NULL,
 created_at DATETIME(3) NOT NULL, published_at DATETIME(3) NULL, download_count BIGINT NOT NULL DEFAULT 0,
 UNIQUE KEY uk_release_build(platform,arch,build_number), KEY idx_release_latest(platform,arch,status,build_number)
 ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
	if err != nil {
		return err
	}
	// ------------ 日期索引覆盖全局趋势，账号与日期复合索引覆盖个人趋势 ---------------
	for _, index := range []struct{ table, name, columns string }{
		{"accounts", "idx_accounts_management_created", "created_at"},
		{"devices", "idx_devices_management_created", "created_at"},
		{"devices", "idx_devices_management_account_created", "account_id,created_at"},
		{"dispatches", "idx_dispatches_management_created", "created_at"},
		{"dispatches", "idx_dispatches_management_account_created", "account_id,created_at"},
	} {
		if err := s.ensureManagementIndex(ctx, index.table, index.name, index.columns); err != nil {
			return err
		}
	}
	return nil
}

// ensureManagementIndex 幂等安装固定统计索引。参数：table/name/columns只能由本模块常量传入；返回值：结构或DDL错误；注意事项：多节点同时创建时仅吞掉1061重复索引错误，并重新核对列顺序。
func (s *MySQL) ensureManagementIndex(ctx context.Context, table, name, columns string) error {
	for attempt := 0; attempt < 2; attempt++ {
		var definition sql.NullString
		err := s.db.QueryRowContext(ctx, `SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=?`, table, name).Scan(&definition)
		if err != nil {
			return err
		}
		if definition.Valid {
			if definition.String != columns {
				return fmt.Errorf("后台统计索引列定义不一致 table=%s index=%s", table, name)
			}
			return nil
		}
		err = s.createManagementIndex(ctx, table, name, columns)
		if err == nil {
			logx.Infof("后台统计索引已创建 table=" + table + " index=" + name)
			return nil
		}
		var duplicate *mysql.MySQLError
		if !errors.As(err, &duplicate) || duplicate.Number != 1061 {
			return err
		}
	}
	return fmt.Errorf("后台统计索引并发创建后仍不可见 table=%s index=%s", table, name)
}

// createManagementIndex 在线创建缺失的统计索引。参数：标识符来自固定迁移列表；返回值：DDL错误；注意事项：独立连接仅等待元数据锁两秒，失败阻止新节点启动，避免迁移在旧节点登录请求前长时间排队。
func (s *MySQL) createManagementIndex(ctx context.Context, table, name, columns string) error {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	var lockWait int
	if err = conn.QueryRowContext(ctx, "SELECT @@SESSION.lock_wait_timeout").Scan(&lockWait); err != nil {
		return err
	}
	// ------------ 会话参数只影响迁移连接，归还连接池前必须恢复 ---------------
	defer func() {
		restoreCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if _, err := conn.ExecContext(restoreCtx, "SET SESSION lock_wait_timeout="+fmt.Sprint(lockWait)); err != nil {
			logx.Warnf("后台统计迁移连接参数恢复失败，丢弃连接 table=" + table)
			_ = conn.Raw(func(any) error { return driver.ErrBadConn })
		}
	}()
	if _, err = conn.ExecContext(ctx, "SET SESSION lock_wait_timeout=2"); err != nil {
		return err
	}
	_, err = conn.ExecContext(ctx, "ALTER TABLE `"+table+"` ADD INDEX `"+name+"` ("+columns+"), ALGORITHM=INPLACE, LOCK=NONE")
	return err
}

// emptyOverviewTrend 准备按日期补零的趋势。参数：start/end为包含首尾的UTC午夜；返回值：顺序日序列、日期索引或范围错误；注意事项：只允许至多366天，不读取或伪造历史活跃数据。
func emptyOverviewTrend(start, end time.Time) ([]map[string]any, map[string]map[string]any, error) {
	days := int(end.Sub(start)/(24*time.Hour)) + 1
	if start.Year() < 1000 || end.Year() < 1000 || !start.Equal(start.UTC().Truncate(24*time.Hour)) || !end.Equal(end.UTC().Truncate(24*time.Hour)) || end.Before(start) || days > MaxOverviewDays {
		return nil, nil, fmt.Errorf("无效的UTC趋势日期范围")
	}
	trend := make([]map[string]any, 0, days)
	byDate := make(map[string]map[string]any, days)
	for day := start; !day.After(end); day = day.AddDate(0, 0, 1) {
		date := day.UTC().Format("2006-01-02")
		item := map[string]any{"date": date, "accountsCreated": int64(0), "devicesCreated": int64(0), "total": int64(0), "completed": int64(0), "failed": int64(0), "pending": int64(0), "running": int64(0)}
		trend = append(trend, item)
		byDate[date] = item
	}
	return trend, byDate, nil
}

// ManagementOverview 聚合账户范围内的运营数据。参数：accountID为空时为全局，startDate/endDate为UTC首尾日期；返回值：原有指标、逐日趋势和平台分布；注意事项：趋势按现存记录创建日聚合，日期筛选不改变累计指标，不加载聊天正文。
func (s *MySQL) ManagementOverview(ctx context.Context, accountID string, startDate, endDate time.Time) (map[string]any, error) {
	trend, byDate, err := emptyOverviewTrend(startDate, endDate)
	if err != nil {
		return nil, err
	}
	metrics := map[string]any{}
	accountFilter := ""
	deviceFilter := " WHERE revoked_at IS NULL"
	taskFilter := ""
	args := []any{}
	if accountID != "" {
		accountFilter = " WHERE id=?"
		deviceFilter += " AND account_id=?"
		taskFilter = " WHERE account_id=?"
		args = append(args, accountID)
	}
	today := time.Now().UTC().Truncate(24 * time.Hour)
	var accounts, accountsToday, devices, activeDevices, primary, onlinePrimary, activeAccounts int64
	err = s.db.QueryRowContext(ctx, `SELECT COUNT(*),COALESCE(SUM(created_at>=?),0) FROM accounts`+accountFilter, append([]any{today}, args...)...).Scan(&accounts, &accountsToday)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	err = s.db.QueryRowContext(ctx, `SELECT COUNT(*),COALESCE(SUM(last_seen_at>=?),0),COALESCE(SUM(is_primary=1),0),COALESCE(SUM(is_primary=1 AND last_seen_at>=?),0),COUNT(DISTINCT IF(last_seen_at>=?,account_id,NULL)) FROM devices`+deviceFilter, append([]any{now.Add(-60 * time.Second), now.Add(-60 * time.Second), now.Add(-7 * 24 * time.Hour)}, args...)...).Scan(&devices, &activeDevices, &primary, &onlinePrimary, &activeAccounts)
	if err != nil {
		return nil, err
	}
	var total, pending, running, done, failed, tasksToday int64
	err = s.db.QueryRowContext(ctx, `SELECT COUNT(*),COALESCE(SUM(status='pending'),0),COALESCE(SUM(status='running'),0),COALESCE(SUM(status='done'),0),COALESCE(SUM(status='failed'),0),COALESCE(SUM(created_at>=?),0) FROM dispatches`+taskFilter, append([]any{today}, args...)...).Scan(&total, &pending, &running, &done, &failed, &tasksToday)
	if err != nil {
		return nil, err
	}
	success := float64(0)
	if done+failed > 0 {
		success = float64(done) * 100 / float64(done+failed)
	}
	metrics = map[string]any{"accounts": accounts, "accountsToday": accountsToday, "devices": devices, "activeDevices": activeDevices, "primaryDevices": primary, "onlinePrimaryDevices": onlinePrimary, "activeAccounts7d": activeAccounts, "tasks": total, "pendingTasks": pending, "runningTasks": running, "completedTasks": done, "failedTasks": failed, "tasksToday": tasksToday, "successRate": success}
	// ------------ 按创建日统计现存任务，闭开边界包含结束日期的全部毫秒 ---------------
	where := " WHERE created_at>=? AND created_at<?"
	trendArgs := []any{startDate, endDate.AddDate(0, 0, 1)}
	if accountID != "" {
		where += " AND account_id=?"
		trendArgs = append(trendArgs, accountID)
	}
	rows, err := s.db.QueryContext(ctx, `SELECT DATE_FORMAT(created_at,'%Y-%m-%d'),COUNT(*),COALESCE(SUM(status='done'),0),COALESCE(SUM(status='failed'),0),COALESCE(SUM(status='pending'),0),COALESCE(SUM(status='running'),0) FROM dispatches`+where+` GROUP BY DATE_FORMAT(created_at,'%Y-%m-%d')`, trendArgs...)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var date string
		var count, complete, failure, queued, executing int64
		if err = rows.Scan(&date, &count, &complete, &failure, &queued, &executing); err != nil {
			rows.Close()
			return nil, err
		}
		if item := byDate[date]; item != nil {
			item["total"] = count
			item["completed"] = complete
			item["failed"] = failure
			item["pending"] = queued
			item["running"] = executing
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	// ------------ 新增账号和设备来自创建时间，设备撤销不抹去创建记录 ---------------
	for _, source := range []struct{ table, field, accountColumn string }{{"accounts", "accountsCreated", "id"}, {"devices", "devicesCreated", "account_id"}} {
		where := " WHERE created_at>=? AND created_at<?"
		growthArgs := []any{startDate, endDate.AddDate(0, 0, 1)}
		if accountID != "" {
			where += " AND " + source.accountColumn + "=?"
			growthArgs = append(growthArgs, accountID)
		}
		// 表名及账号列均来自上面的固定白名单，日期和账号值始终使用绑定参数。
		rows, err = s.db.QueryContext(ctx, `SELECT DATE_FORMAT(created_at,'%Y-%m-%d'),COUNT(*) FROM `+source.table+where+` GROUP BY DATE_FORMAT(created_at,'%Y-%m-%d')`, growthArgs...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var date string
			var count int64
			if err = rows.Scan(&date, &count); err != nil {
				rows.Close()
				return nil, err
			}
			if item := byDate[date]; item != nil {
				item[source.field] = count
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}
	rows, err = s.db.QueryContext(ctx, `SELECT platform,COUNT(*) FROM devices`+deviceFilter+` GROUP BY platform`, args...)
	if err != nil {
		return nil, err
	}
	platforms := []map[string]any{}
	for rows.Next() {
		var platform string
		var count int64
		if err = rows.Scan(&platform, &count); err != nil {
			rows.Close()
			return nil, err
		}
		platforms = append(platforms, map[string]any{"platform": platform, "count": count})
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	var published, drafts, downloads int64
	err = s.db.QueryRowContext(ctx, `SELECT COALESCE(SUM(status='published'),0),COALESCE(SUM(status='draft'),0),COALESCE(SUM(download_count),0) FROM app_releases`).Scan(&published, &drafts, &downloads)
	if err != nil {
		return nil, err
	}
	scope := "global"
	if accountID != "" {
		scope = "account"
		drafts = 0
	} else {
		metrics["downloads"] = downloads
	}
	return map[string]any{"scope": scope, "metrics": metrics, "trend": trend, "platforms": platforms, "releases": map[string]any{"published": published, "drafts": drafts}, "timezone": "UTC"}, nil
}

// ManagementList 查询不含敏感内容的分页列表。参数：kind 指定账号、设备或任务，q 为关键字，status 为任务状态；返回值：当前页与总数；注意事项：所有动态数据均绑定占位符。
func (s *MySQL) ManagementList(ctx context.Context, accountID, kind, q, status string, page, size int) ([]map[string]any, int64, error) {
	var from, fields, search, order string
	where := " WHERE 1=1"
	args := []any{}
	switch kind {
	case "accounts":
		from = "accounts a"
		fields = "a.id,a.email,a.name,a.provider,a.created_at,(SELECT COUNT(*) FROM devices d WHERE d.account_id=a.id AND d.revoked_at IS NULL),(SELECT COUNT(*) FROM dispatches t WHERE t.account_id=a.id)"
		search = "(a.email LIKE ? OR a.name LIKE ?)"
		order = "a.created_at DESC,a.id"
		if accountID != "" {
			where += " AND a.id=?"
			args = append(args, accountID)
		}
	case "devices":
		from = "devices d JOIN accounts a ON a.id=d.account_id"
		fields = "d.id,d.account_id,a.email,d.name,d.platform,d.is_primary,d.last_seen_at,d.created_at"
		search = "(a.email LIKE ? OR d.name LIKE ?)"
		order = "d.created_at DESC,d.id"
		where += " AND d.revoked_at IS NULL"
		if accountID != "" {
			where += " AND d.account_id=?"
			args = append(args, accountID)
		}
	case "tasks":
		from = "dispatches t JOIN accounts a ON a.id=t.account_id"
		fields = "t.id,t.account_id,a.email,t.mode,t.status,t.created_at,t.updated_at"
		search = "(a.email LIKE ? OR t.id LIKE ?)"
		order = "t.created_at DESC,t.id"
		if accountID != "" {
			where += " AND t.account_id=?"
			args = append(args, accountID)
		}
		if status != "" {
			where += " AND t.status=?"
			args = append(args, status)
		}
	default:
		return nil, 0, fmt.Errorf("未知后台列表")
	}
	if q != "" {
		where += " AND " + search
		args = append(args, "%"+q+"%", "%"+q+"%")
	}
	var total int64
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+from+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.db.QueryContext(ctx, "SELECT "+fields+" FROM "+from+where+" ORDER BY "+order+" LIMIT ? OFFSET ?", append(args, size, (page-1)*size)...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		item := map[string]any{}
		var id, email, name, provider, owner, platform, mode, statusValue string
		var created, updated time.Time
		var seen sql.NullTime
		var primary bool
		var devices, tasks int64
		switch kind {
		case "accounts":
			err = rows.Scan(&id, &email, &name, &provider, &created, &devices, &tasks)
			item = map[string]any{"id": id, "email": email, "name": name, "provider": provider, "createdAt": created, "deviceCount": devices, "taskCount": tasks}
		case "devices":
			err = rows.Scan(&id, &owner, &email, &name, &platform, &primary, &seen, &created)
			var lastSeen any
			if seen.Valid {
				lastSeen = seen.Time
			}
			item = map[string]any{"id": id, "accountId": owner, "accountEmail": email, "name": name, "platform": platform, "isPrimary": primary, "lastSeenAt": lastSeen, "createdAt": created, "online": seen.Valid && seen.Time.After(time.Now().Add(-60*time.Second))}
		case "tasks":
			err = rows.Scan(&id, &owner, &email, &mode, &statusValue, &created, &updated)
			item = map[string]any{"id": id, "accountId": owner, "accountEmail": email, "mode": mode, "status": statusValue, "createdAt": created, "updatedAt": updated}
		}
		if err != nil {
			return nil, 0, err
		}
		items = append(items, item)
	}
	return items, total, rows.Err()
}

const releaseColumns = "id,platform,arch,version,build_number,notes,file_name,file_size,sha256,storage_key,status,created_by,created_at,published_at,download_count"

// scanRelease 读取单条发布元数据。参数：row 为数据库游标；返回值：发布记录或标准不存在错误；注意事项：不读取安装包内容。
func scanRelease(row interface{ Scan(...any) error }) (Release, error) {
	var item Release
	err := row.Scan(&item.ID, &item.Platform, &item.Arch, &item.Version, &item.BuildNumber, &item.Notes, &item.FileName, &item.Size, &item.SHA256, &item.StorageKey, &item.Status, &item.CreatedBy, &item.CreatedAt, &item.PublishedAt, &item.DownloadCount)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return item, err
}

// SaveRelease 持久化已完整写入磁盘的草稿。参数：item 为元数据；返回值：写入错误；注意事项：数据库唯一键防止并发覆盖同一构建。
func (s *MySQL) SaveRelease(ctx context.Context, item Release) error {
	_, err := s.db.ExecContext(ctx, "INSERT INTO app_releases ("+releaseColumns+") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", item.ID, item.Platform, item.Arch, item.Version, item.BuildNumber, item.Notes, item.FileName, item.Size, item.SHA256, item.StorageKey, item.Status, item.CreatedBy, item.CreatedAt, item.PublishedAt, item.DownloadCount)
	var duplicate *mysql.MySQLError
	if errors.As(err, &duplicate) && duplicate.Number == 1062 {
		return ErrAccountExists
	}
	return err
}

// FindRelease 按不可猜测的 ID 查找安装包。参数：id 为发布标识；返回值：元数据；注意事项：公开下载还需检查发布状态。
func (s *MySQL) FindRelease(ctx context.Context, id string) (Release, error) {
	return scanRelease(s.db.QueryRowContext(ctx, "SELECT "+releaseColumns+" FROM app_releases WHERE id=?", id))
}

// ListReleases 返回有限大小的版本列表。参数：all 为管理员可见性，page 和 size 为分页；返回值：记录及总数；注意事项：普通用户仅可见已发布版本。
func (s *MySQL) ListReleases(ctx context.Context, all bool, platform string, page, size int) ([]Release, int64, error) {
	where := " WHERE 1=1"
	args := []any{}
	if !all {
		where += " AND status='published'"
	}
	if platform != "" {
		where += " AND platform=?"
		args = append(args, platform)
	}
	var total int64
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM app_releases"+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.db.QueryContext(ctx, "SELECT "+releaseColumns+" FROM app_releases"+where+" ORDER BY created_at DESC,id LIMIT ? OFFSET ?", append(args, size, (page-1)*size)...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	items := []Release{}
	for rows.Next() {
		item, err := scanRelease(rows)
		if err != nil {
			return nil, 0, err
		}
		items = append(items, item)
	}
	return items, total, rows.Err()
}

// SetReleaseStatus 变更发布状态。参数：id 为版本，status 为 published 或 withdrawn；返回值：最新记录；注意事项：撤回后公开查询和新下载立即失效，旧版本保留用于回退。
func (s *MySQL) SetReleaseStatus(ctx context.Context, id, status string) (Release, error) {
	_, err := s.db.ExecContext(ctx, `UPDATE app_releases SET status=?,published_at=IF(?='published',UTC_TIMESTAMP(3),published_at) WHERE id=?`, status, status, id)
	if err != nil {
		return Release{}, err
	}
	return s.FindRelease(ctx, id)
}

// LatestReleases 获取平台可兼容的候选版本。参数：platform 与 arch 为已校验客户端值；返回值：按语义版本和构建号倒序的已发布记录；注意事项：客户端还需按版本号和构建号判断升级。
func (s *MySQL) LatestReleases(ctx context.Context, platform, arch string) ([]Release, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT "+releaseColumns+" FROM app_releases WHERE platform=? AND (arch=? OR arch='universal') AND status='published' ORDER BY CAST(SUBSTRING_INDEX(version,'.',1) AS UNSIGNED) DESC,CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(version,'.',2),'.',-1) AS UNSIGNED) DESC,CAST(SUBSTRING_INDEX(version,'.',-1) AS UNSIGNED) DESC,build_number DESC,published_at DESC LIMIT 100", platform, arch)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Release{}
	for rows.Next() {
		item, err := scanRelease(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// CountDownload 原子累计下载请求数。参数：id 为已发布记录；返回值：更新错误；注意事项：续传也计一次，不代表安装成功数。
func (s *MySQL) CountDownload(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, "UPDATE app_releases SET download_count=download_count+1 WHERE id=? AND status='published'", id)
	return err
}
