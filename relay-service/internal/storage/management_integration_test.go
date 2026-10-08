package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"agents-team-relay/internal/config"
	"github.com/go-sql-driver/mysql"
	"github.com/google/uuid"
)

// TestManagementMySQLIntegration 验证真实MySQL迁移、隔离统计、分页及发布生命周期。参数：t为测试句柄；返回值：无；注意事项：仅使用随机临时数据库，结束后整库清理，绝不修改.env.test指向的业务数据库。
func TestManagementMySQLIntegration(t *testing.T) {
	if os.Getenv("RELAY_MANAGEMENT_INTEGRATION") != "1" {
		t.Skip("设置 RELAY_MANAGEMENT_INTEGRATION=1 RELAY_ENV=test 才连接独立临时数据库")
	}
	_, source, _, _ := runtime.Caller(0)
	root := filepath.Clean(filepath.Join(filepath.Dir(source), "../.."))
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Chdir(root); err != nil {
		t.Fatal(err)
	}
	defer os.Chdir(cwd)
	cfg, err := config.Load()
	if err != nil || cfg.Env != "test" {
		t.Fatal("必须使用测试配置")
	}
	cfg.MySQL.DBName = "relay_admin_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	// ------------ 临时库独立迁移与最终清理 ---------------
	admin, err := sql.Open("mysql", cfg.MySQL.DSN(""))
	if err != nil {
		t.Fatal("无法连接测试实例")
	}
	defer admin.Close()
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := admin.ExecContext(ctx, "DROP DATABASE IF EXISTS `"+cfg.MySQL.DBName+"`"); err != nil {
			t.Error("清理独立临时数据库失败", err)
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	store, err := OpenMySQL(ctx, cfg.MySQL)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	store.db.SetMaxOpenConns(1)
	if _, err = store.db.ExecContext(ctx, "SET SESSION sql_mode=CONCAT_WS(',',@@SESSION.sql_mode,'ONLY_FULL_GROUP_BY')"); err != nil {
		t.Fatal("启用严格分组模式失败", err)
	}
	if err = store.migrateManagement(ctx); err != nil {
		t.Fatal("重复迁移失败", err)
	}
	var indexCount int
	if err = store.db.QueryRowContext(ctx, `SELECT COUNT(DISTINCT TABLE_NAME,INDEX_NAME) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND INDEX_NAME IN ('idx_accounts_management_created','idx_devices_management_created','idx_devices_management_account_created','idx_dispatches_management_created','idx_dispatches_management_account_created')`).Scan(&indexCount); err != nil || indexCount != 5 {
		t.Fatal("日期范围统计索引没有正确创建", indexCount, err)
	}
	// 独立连接模拟多个节点同时启动，重复索引竞争不得让节点启动失败。
	if _, err = store.db.ExecContext(ctx, "ALTER TABLE devices DROP INDEX idx_devices_management_account_created"); err != nil {
		t.Fatal(err)
	}
	store.db.SetMaxOpenConns(2)
	indexResults := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() {
			indexResults <- store.ensureManagementIndex(ctx, "devices", "idx_devices_management_account_created", "account_id,created_at")
		}()
	}
	for i := 0; i < 2; i++ {
		if err = <-indexResults; err != nil {
			t.Fatal("并发统计索引迁移失败", err)
		}
	}
	store.db.SetMaxOpenConns(1)
	if _, err = store.db.ExecContext(ctx, "SET SESSION sql_mode=CONCAT_WS(',',@@SESSION.sql_mode,'ONLY_FULL_GROUP_BY')"); err != nil {
		t.Fatal(err)
	}
	if err = store.migrateManagement(ctx); err != nil {
		t.Fatal("并发创建后的重复迁移失败", err)
	}
	verifyManagementIndexLock(t, ctx, store, cfg.MySQL)
	accountIDs := []string{}
	deviceIDs := []string{}
	now := time.Now().UTC()
	today := now.Truncate(24 * time.Hour)
	for index, email := range []string{"first@example.test", "second@example.test"} {
		account, err := store.RegisterEmail(ctx, Account{ID: uuid.NewString(), Email: email, Name: "集成测试", Provider: "email"}, "test-only-password-hash")
		if err != nil {
			t.Fatal(err)
		}
		accountIDs = append(accountIDs, account.ID)
		device, err := store.UpsertDevice(ctx, Device{ID: uuid.NewString(), AccountID: account.ID, ClientDeviceID: uuid.NewString(), Name: "测试电脑", Platform: "mac", TokenHash: strings.ReplaceAll(uuid.NewString(), "-", "") + strings.ReplaceAll(uuid.NewString(), "-", "")})
		if err != nil {
			t.Fatal(err)
		}
		deviceIDs = append(deviceIDs, device.ID)
		if err = store.TouchDevice(ctx, device.ID, now); err != nil {
			t.Fatal(err)
		}
		status := "done"
		if index == 1 {
			status = "failed"
		}
		err = store.WithAccount(ctx, account.ID, func(tx Tx) error {
			return tx.InsertDispatch(ctx, Dispatch{ID: uuid.NewString(), AccountID: account.ID, SourceDeviceID: device.ID, ClientRequestID: uuid.NewString(), Mode: "agent", Payload: []byte("{}"), Status: status, CreatedAt: now, UpdatedAt: now})
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	overview, err := store.ManagementOverview(ctx, "", today.AddDate(0, 0, -29), today)
	if err != nil {
		t.Fatal(err)
	}
	metrics := overview["metrics"].(map[string]any)
	if metrics["accounts"] != int64(2) || metrics["tasks"] != int64(2) || metrics["successRate"] != float64(50) {
		t.Fatal("全局聚合错误", metrics)
	}
	trend := overview["trend"].([]map[string]any)
	if len(trend) != 30 || trend[29]["accountsCreated"] != int64(2) || trend[29]["devicesCreated"] != int64(2) || trend[29]["total"] != int64(2) || trend[29]["completed"] != int64(1) || trend[29]["failed"] != int64(1) {
		t.Fatal("默认窗口的新增账号、设备或任务统计错误", trend)
	}
	overview, err = store.ManagementOverview(ctx, accountIDs[0], today.AddDate(0, 0, -29), today)
	if err != nil {
		t.Fatal(err)
	}
	metrics = overview["metrics"].(map[string]any)
	if metrics["accounts"] != int64(1) || metrics["tasks"] != int64(1) || metrics["failedTasks"] != int64(0) {
		t.Fatal("账户统计泄漏", metrics)
	}
	for _, kind := range []string{"accounts", "devices", "tasks"} {
		items, total, err := store.ManagementList(ctx, accountIDs[0], kind, "second", "", 1, 20)
		if err != nil || total != 0 || len(items) != 0 {
			t.Fatal("搜索越过账户边界", kind, total, err)
		}
		items, total, err = store.ManagementList(ctx, "", kind, "", "", 1, 1)
		if err != nil || total != 2 || len(items) != 1 {
			t.Fatal("全局分页错误", kind, total, err)
		}
	}
	item := Release{ID: uuid.NewString(), Platform: "mac", Arch: "arm64", Version: "0.5.6", BuildNumber: 11, Notes: "", FileName: "Chorus.dmg", Size: 512, SHA256: strings.Repeat("a", 64), StorageKey: "test.dmg", Status: "draft", CreatedBy: "admin@example.test", CreatedAt: now}
	if err = store.SaveRelease(ctx, item); err != nil {
		t.Fatal(err)
	}
	if err = store.SaveRelease(ctx, item); !errors.Is(err, ErrAccountExists) {
		t.Fatal("唯一构建未受保护", err)
	}
	latest, err := store.LatestReleases(ctx, "mac", "arm64")
	if err != nil || len(latest) != 0 {
		t.Fatal("草稿对外可见")
	}
	published, err := store.SetReleaseStatus(ctx, item.ID, "published")
	if err != nil || published.PublishedAt == nil {
		t.Fatal("发布失败", err)
	}
	latest, err = store.LatestReleases(ctx, "mac", "arm64")
	if err != nil || len(latest) != 1 {
		t.Fatal("已发布版本不可见", err)
	}
	if err = store.CountDownload(ctx, item.ID); err != nil {
		t.Fatal(err)
	}
	stored, err := store.FindRelease(ctx, item.ID)
	if err != nil || stored.DownloadCount != 1 {
		t.Fatal("下载计数失败", err)
	}
	if _, err = store.SetReleaseStatus(ctx, item.ID, "withdrawn"); err != nil {
		t.Fatal(err)
	}
	latest, err = store.LatestReleases(ctx, "mac", "arm64")
	if err != nil || len(latest) != 0 {
		t.Fatal("撤回版本仍可见", err)
	}

	// ------------ 构造包含首尾毫秒、空日期及其他账号的真实历史记录 ---------------
	startDate, endDate := today.AddDate(0, 0, -5), today.AddDate(0, 0, -1)
	endExclusive := endDate.AddDate(0, 0, 1)
	if _, err = store.db.ExecContext(ctx, "UPDATE accounts SET created_at=? WHERE id=?", startDate, accountIDs[0]); err != nil {
		t.Fatal(err)
	}
	if _, err = store.db.ExecContext(ctx, "UPDATE devices SET created_at=? WHERE id=?", startDate, deviceIDs[0]); err != nil {
		t.Fatal(err)
	}
	revoked, err := store.UpsertDevice(ctx, Device{ID: uuid.NewString(), AccountID: accountIDs[0], ClientDeviceID: uuid.NewString(), Name: "已撤销历史设备", Platform: "android", TokenHash: strings.ReplaceAll(uuid.NewString(), "-", "") + strings.ReplaceAll(uuid.NewString(), "-", "")})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.db.ExecContext(ctx, "UPDATE devices SET created_at=?,revoked_at=? WHERE id=?", endExclusive.Add(-time.Millisecond), now, revoked.ID); err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct {
		owner   int
		created time.Time
		status  string
	}{
		{0, startDate.Add(-time.Millisecond), "done"},
		{0, startDate, "pending"},
		{0, startDate.AddDate(0, 0, 2), "running"},
		{0, endExclusive.Add(-time.Millisecond), "done"},
		{0, endExclusive, "failed"},
		{1, startDate, "failed"},
	} {
		err = store.WithAccount(ctx, accountIDs[item.owner], func(tx Tx) error {
			return tx.InsertDispatch(ctx, Dispatch{ID: uuid.NewString(), AccountID: accountIDs[item.owner], SourceDeviceID: deviceIDs[item.owner], ClientRequestID: uuid.NewString(), Mode: "agent", Payload: []byte("{}"), Status: item.status, CreatedAt: item.created, UpdatedAt: now})
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	overview, err = store.ManagementOverview(ctx, "", startDate, endDate)
	if err != nil {
		t.Fatal("严格分组模式下自定义日期聚合失败", err)
	}
	trend = overview["trend"].([]map[string]any)
	if len(trend) != 5 || trend[0]["accountsCreated"] != int64(1) || trend[0]["devicesCreated"] != int64(1) || trend[0]["total"] != int64(2) || trend[0]["pending"] != int64(1) || trend[0]["failed"] != int64(1) || trend[2]["running"] != int64(1) || trend[4]["completed"] != int64(1) || trend[4]["devicesCreated"] != int64(1) {
		t.Fatal("历史区间的首尾边界、多维度或撤销设备统计错误", trend)
	}
	for _, index := range []int{1, 3} {
		for _, key := range []string{"accountsCreated", "devicesCreated", "total", "completed", "failed", "pending", "running"} {
			if trend[index][key] != int64(0) {
				t.Fatal("无数据日期没有补零", index, key, trend[index])
			}
		}
	}
	if overview["metrics"].(map[string]any)["tasks"] != int64(8) {
		t.Fatal("日期筛选不应改变累计任务口径")
	}
	overview, err = store.ManagementOverview(ctx, accountIDs[0], startDate, endDate)
	if err != nil {
		t.Fatal(err)
	}
	trend = overview["trend"].([]map[string]any)
	if trend[0]["total"] != int64(1) || trend[0]["failed"] != int64(0) || trend[0]["accountsCreated"] != int64(1) || trend[4]["devicesCreated"] != int64(1) || overview["metrics"].(map[string]any)["devices"] != int64(1) {
		t.Fatal("日期趋势泄漏其他账号或有效设备指标口径改变", trend)
	}
	overview, err = store.ManagementOverview(ctx, "", endDate, endDate)
	if err != nil {
		t.Fatal(err)
	}
	trend = overview["trend"].([]map[string]any)
	if len(trend) != 1 || trend[0]["total"] != int64(1) || trend[0]["completed"] != int64(1) || trend[0]["devicesCreated"] != int64(1) {
		t.Fatal("单日查询没有覆盖当天全部毫秒", trend)
	}
}

// verifyManagementIndexLock 验证在线索引不会长时间等待旧事务并污染业务连接。参数：store使用单连接池，cfg指向临时库；返回值：无；注意事项：另一连接持有真实元数据锁，超时后释放并验证可重试迁移。
func verifyManagementIndexLock(t *testing.T, ctx context.Context, store *MySQL, cfg config.MySQLConfig) {
	t.Helper()
	if _, err := store.db.ExecContext(ctx, "ALTER TABLE accounts DROP INDEX idx_accounts_management_created"); err != nil {
		t.Fatal(err)
	}
	var originalWait int
	if err := store.db.QueryRowContext(ctx, "SELECT @@SESSION.lock_wait_timeout").Scan(&originalWait); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(ctx, "SET SESSION lock_wait_timeout=17"); err != nil {
		t.Fatal(err)
	}
	defer store.db.ExecContext(context.Background(), "SET SESSION lock_wait_timeout="+fmt.Sprint(originalWait))
	holder, err := sql.Open("mysql", cfg.DSN(cfg.DBName))
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Close()
	tx, err := holder.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	var count int
	if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM accounts").Scan(&count); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	err = store.ensureManagementIndex(ctx, "accounts", "idx_accounts_management_created", "created_at")
	var lockError *mysql.MySQLError
	if !errors.As(err, &lockError) || lockError.Number != 1205 || time.Since(started) > 6*time.Second {
		t.Fatal("索引未按短元数据锁超时失败", time.Since(started), err)
	}
	if err = store.db.QueryRowContext(ctx, "SELECT @@SESSION.lock_wait_timeout").Scan(&count); err != nil || count != 17 {
		t.Fatal("迁移超时污染连接池会话设置", count, err)
	}
	if err = tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	if err = store.ensureManagementIndex(ctx, "accounts", "idx_accounts_management_created", "created_at"); err != nil {
		t.Fatal("元数据锁释放后迁移不能恢复", err)
	}
	if err = store.db.QueryRowContext(ctx, "SELECT @@SESSION.lock_wait_timeout").Scan(&count); err != nil || count != 17 {
		t.Fatal("成功迁移污染连接池会话设置", count, err)
	}
}
