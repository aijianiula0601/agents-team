package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"agents-team-relay/internal/config"
	"agents-team-relay/internal/logx"

	"github.com/go-sql-driver/mysql"
)

// MySQL 是测试和生产使用的共享库存储。
type MySQL struct {
	db *sql.DB
}

// OpenMySQL 建库、连接并迁移表结构。
//
// 参数：ctx 控制建库和迁移超时；cfg 为 MySQL 配置。
// 返回值：可用存储。连接或迁移失败时返回错误。
// 注意事项：数据库名必须已通过标识符校验，不能把密码写入日志。
func OpenMySQL(ctx context.Context, cfg config.MySQLConfig) (*MySQL, error) {
	if !safeDBName(cfg.DBName) {
		return nil, fmt.Errorf("数据库名不合法")
	}
	admin, err := sql.Open("mysql", cfg.DSN(""))
	if err != nil {
		return nil, fmt.Errorf("打开 MySQL 管理连接失败: %w", err)
	}
	admin.SetMaxOpenConns(1)
	createCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	_, err = admin.ExecContext(createCtx, "CREATE DATABASE IF NOT EXISTS `"+cfg.DBName+"` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci")
	cancel()
	_ = admin.Close()
	if err != nil {
		return nil, fmt.Errorf("创建数据库失败: %w", err)
	}

	db, err := sql.Open("mysql", cfg.DSN(cfg.DBName))
	if err != nil {
		return nil, fmt.Errorf("打开 MySQL 失败: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetConnMaxLifetime(30 * time.Minute)
	pingCtx, pingCancel := context.WithTimeout(ctx, 8*time.Second)
	err = db.PingContext(pingCtx)
	pingCancel()
	if err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("连接 MySQL 失败: %w", err)
	}
	store := &MySQL{db: db}
	migrateCtx, migrateCancel := context.WithTimeout(ctx, 30*time.Second)
	err = store.migrate(migrateCtx)
	migrateCancel()
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	db.SetMaxOpenConns(20)
	db.SetMaxIdleConns(5)
	logx.Infof("MySQL 已就绪 host=%s db=%s", cfg.Host, cfg.DBName)
	return store, nil
}

// Close 关闭连接池。
//
// 参数：无。
// 返回值：驱动关闭错误。
// 注意事项：进程退出时调用一次。
func (s *MySQL) Close() error { return s.db.Close() }

// Ping 检查数据库连接。
//
// 参数：ctx 控制超时。
// 返回值：连接失败时返回错误。
// 注意事项：供就绪检查使用。
func (s *MySQL) Ping(ctx context.Context) error { return s.db.PingContext(ctx) }

// migrate 创建业务表。
//
// 参数：ctx 控制超时。
// 返回值：任一条 DDL 失败即返回错误。
// 注意事项：语句保持幂等，重复部署不能破坏已有数据。
func (s *MySQL) migrate(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS accounts (
			id CHAR(36) NOT NULL PRIMARY KEY,
			email VARCHAR(320) NOT NULL,
			name VARCHAR(128) NOT NULL DEFAULT '',
			picture VARCHAR(512) NOT NULL DEFAULT '',
			provider VARCHAR(32) NOT NULL,
			created_at DATETIME(3) NOT NULL,
			updated_at DATETIME(3) NOT NULL,
			UNIQUE KEY uk_accounts_email (email)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
		`CREATE TABLE IF NOT EXISTS account_credentials (account_id %s NOT NULL PRIMARY KEY, password_hash VARCHAR(255) NOT NULL, auth_version BIGINT NOT NULL DEFAULT 0, created_at DATETIME(3) NOT NULL, CONSTRAINT fk_credentials_account FOREIGN KEY (account_id) REFERENCES accounts (id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
		`CREATE TABLE IF NOT EXISTS devices (
			id CHAR(36) NOT NULL PRIMARY KEY,
			account_id CHAR(36) NOT NULL,
			client_device_id VARCHAR(128) NOT NULL,
			name VARCHAR(128) NOT NULL,
			platform VARCHAR(32) NOT NULL,
			is_primary TINYINT(1) NOT NULL DEFAULT 0,
			token_hash CHAR(64) NOT NULL,
			last_seen_at DATETIME(3) NULL,
			revoked_at DATETIME(3) NULL,
			created_at DATETIME(3) NOT NULL,
			updated_at DATETIME(3) NOT NULL,
			UNIQUE KEY uk_devices_client (account_id, client_device_id),
			UNIQUE KEY uk_devices_token (token_hash),
			KEY idx_devices_account (account_id),
			CONSTRAINT fk_devices_account FOREIGN KEY (account_id) REFERENCES accounts (id)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
		`CREATE TABLE IF NOT EXISTS chat_states (
			account_id CHAR(36) NOT NULL PRIMARY KEY,
			revision BIGINT NOT NULL,
			body LONGTEXT NOT NULL,
			updated_by_device CHAR(36) NULL,
			updated_at DATETIME(3) NOT NULL,
			CONSTRAINT fk_states_account FOREIGN KEY (account_id) REFERENCES accounts (id)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
		`CREATE TABLE IF NOT EXISTS dispatches (
			id CHAR(36) NOT NULL PRIMARY KEY,
			account_id CHAR(36) NOT NULL,
			source_device_id CHAR(36) NOT NULL,
			client_request_id VARCHAR(128) NOT NULL,
			mode VARCHAR(32) NOT NULL,
			room_id VARCHAR(128) NOT NULL DEFAULT '',
			user_text MEDIUMTEXT NOT NULL,
			payload LONGTEXT NOT NULL,
			status VARCHAR(32) NOT NULL,
			result LONGTEXT NULL,
			error_message VARCHAR(1024) NOT NULL DEFAULT '',
			created_at DATETIME(3) NOT NULL,
			updated_at DATETIME(3) NOT NULL,
			UNIQUE KEY uk_dispatch_client (account_id, client_request_id),
			KEY idx_dispatch_status (account_id, status, created_at),
			CONSTRAINT fk_dispatch_account FOREIGN KEY (account_id) REFERENCES accounts (id)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
		`CREATE TABLE IF NOT EXISTS dispatch_claims (dispatch_id %s NOT NULL PRIMARY KEY, device_id CHAR(36) NOT NULL, token_hash CHAR(64) NOT NULL, expires_at DATETIME(3) NOT NULL, CONSTRAINT fk_claim_dispatch FOREIGN KEY (dispatch_id) REFERENCES dispatches (id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
		`CREATE TABLE IF NOT EXISTS invites (
			code_hash CHAR(64) NOT NULL PRIMARY KEY,
			account_id CHAR(36) NOT NULL,
			created_by_device CHAR(36) NOT NULL,
			expires_at DATETIME(3) NOT NULL,
			used_at DATETIME(3) NULL,
			created_at DATETIME(3) NOT NULL,
			KEY idx_invites_account (account_id),
			CONSTRAINT fk_invites_account FOREIGN KEY (account_id) REFERENCES accounts (id)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
	}
	for _, statement := range statements {
		// 外键 UUID 列必须沿用实际被引用列的字符集和排序规则，不能依赖 MySQL 实例默认值。
		reference := ""
		if strings.HasPrefix(statement, "CREATE TABLE IF NOT EXISTS account_credentials") {
			reference = "accounts"
		}
		if strings.HasPrefix(statement, "CREATE TABLE IF NOT EXISTS dispatch_claims") {
			reference = "dispatches"
		}
		if reference != "" {
			definition, err := s.foreignIDDefinition(ctx, reference)
			if err != nil {
				return err
			}
			statement = fmt.Sprintf(statement, definition)
		}
		if _, err := s.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("迁移表结构失败: %w", err)
		}
	}
	// 历史版本曾把手机设为主设备，清理该标记，保留账号和聊天数据。
	if _, err := s.db.ExecContext(ctx, `UPDATE devices SET is_primary=0 WHERE is_primary=1 AND platform NOT IN ('mac','windows','linux')`); err != nil {
		return fmt.Errorf("校正执行设备标记失败: %w", err)
	}
	// 旧部署 TEXT 只能保存 64 KB，升级正文列允许完整聊天输入，原记录保留。
	var columnType string
	if err := s.db.QueryRowContext(ctx, `SELECT DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='dispatches' AND COLUMN_NAME='user_text'`).Scan(&columnType); err != nil {
		return fmt.Errorf("检查任务正文列失败: %w", err)
	}
	if columnType == "text" {
		if _, err := s.db.ExecContext(ctx, `ALTER TABLE dispatches MODIFY COLUMN user_text MEDIUMTEXT NOT NULL`); err != nil {
			return fmt.Errorf("升级任务正文列失败: %w", err)
		}
	}
	if err := s.migrateCredentialVersion(ctx); err != nil {
		return err
	}
	return s.migrateManagement(ctx)
}

// UpsertAccount 按邮箱创建或更新账号，并补齐聊天快照。
//
// 参数：account 包含新账号候选 ID 和资料。
// 返回值：库中实际账号。重复邮箱沿用原 ID。
// 注意事项：邮箱由服务层转成小写。
func (s *MySQL) UpsertAccount(ctx context.Context, account Account) (Account, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Account{}, err
	}
	defer func() { _ = tx.Rollback() }()
	now := time.Now().UTC()
	_, err = tx.ExecContext(ctx, `INSERT INTO accounts (id, email, name, picture, provider, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE name=IF(VALUES(name)='', name, VALUES(name)), picture=IF(VALUES(picture)='', picture, VALUES(picture)), updated_at=VALUES(updated_at)`,
		account.ID, account.Email, account.Name, account.Picture, account.Provider, now, now)
	if err != nil {
		return Account{}, fmt.Errorf("保存账号失败: %w", err)
	}
	stored, err := scanAccount(tx.QueryRowContext(ctx, `SELECT id, email, name, picture, provider, created_at, updated_at FROM accounts WHERE email=?`, account.Email))
	if err != nil {
		return Account{}, err
	}
	if stored.Provider != account.Provider {
		return Account{}, ErrProviderConflict
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO chat_states (account_id, revision, body, updated_at) VALUES (?, 0, ?, ?)
		ON DUPLICATE KEY UPDATE account_id=account_id`, stored.ID, emptyState, now)
	if err != nil {
		return Account{}, fmt.Errorf("初始化聊天记录失败: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return Account{}, err
	}
	return stored, nil
}

// FindAccountByEmail 按邮箱读取账号。
//
// 参数：email 为规范化邮箱。
// 返回值：不存在时返回 ErrNotFound。
// 注意事项：不会创建账号。
func (s *MySQL) FindAccountByEmail(ctx context.Context, email string) (Account, error) {
	account, err := scanAccount(s.db.QueryRowContext(ctx, `SELECT id, email, name, picture, provider, created_at, updated_at FROM accounts WHERE email=?`, email))
	if errors.Is(err, sql.ErrNoRows) {
		return Account{}, ErrNotFound
	}
	return account, err
}

// UpsertDevice 登记设备并分配主设备身份。
//
// 参数：device 需要账号、客户端设备号、新令牌摘要和候选 ID。
// 返回值：保存后的设备。
// 注意事项：重复登录替换令牌摘要，旧令牌立即失效。
func (s *MySQL) UpsertDevice(ctx context.Context, device Device) (Device, error) {
	return s.UpsertAuthenticatedDevice(ctx, device, "", "", -1)
}

// UpsertAuthenticatedDevice 在账号锁内校验凭据版本后登记设备。参数：expectedEmail和expectedPasswordHash为此前成功认证的值，空值仅供可信内部登记；返回值：新设备会话；注意事项：并发改邮箱或重置密码后，旧认证结果不得重新签发有效令牌。
func (s *MySQL) UpsertAuthenticatedDevice(ctx context.Context, device Device, expectedEmail, expectedPasswordHash string, expectedVersion int64) (Device, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Device{}, err
	}
	defer func() { _ = tx.Rollback() }()
	var email string
	err = tx.QueryRowContext(ctx, `SELECT email FROM accounts WHERE id=? FOR UPDATE`, device.AccountID).Scan(&email)
	if errors.Is(err, sql.ErrNoRows) {
		return Device{}, ErrNotFound
	}
	if err != nil {
		return Device{}, err
	}
	if expectedEmail != "" && email != expectedEmail {
		return Device{}, ErrCredentialsChanged
	}
	if expectedPasswordHash != "" {
		var currentHash string
		var currentVersion int64
		if err := tx.QueryRowContext(ctx, "SELECT password_hash,auth_version FROM account_credentials WHERE account_id=?", device.AccountID).Scan(&currentHash, &currentVersion); err != nil {
			return Device{}, err
		}
		if currentHash != expectedPasswordHash || (expectedVersion >= 0 && currentVersion != expectedVersion) {
			return Device{}, ErrCredentialsChanged
		}
	}
	var existingID string
	var primaryInt int
	var createdAt time.Time
	var revokedAt sql.NullTime
	err = tx.QueryRowContext(ctx, `SELECT id, is_primary, created_at, revoked_at FROM devices WHERE account_id=? AND client_device_id=? FOR UPDATE`, device.AccountID, device.ClientDeviceID).Scan(&existingID, &primaryInt, &createdAt, &revokedAt)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return Device{}, err
	}
	if errors.Is(err, sql.ErrNoRows) {
		existingID = ""
	}
	excludeID := device.ID
	if existingID != "" {
		excludeID = existingID
	}
	var others int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM devices WHERE account_id=? AND revoked_at IS NULL AND is_primary=1 AND platform IN ('mac','windows','linux') AND id<>?`, device.AccountID, excludeID).Scan(&others); err != nil {
		return Device{}, err
	}
	now := time.Now().UTC()
	device.IsPrimary = CanExecute(device.Platform) && KeepOrAssignPrimary(existingID != "" && primaryInt == 1 && !revokedAt.Valid, others > 0)
	device.Revoked = false
	device.UpdatedAt = now
	if existingID == "" {
		device.CreatedAt = now
		_, err = tx.ExecContext(ctx, `INSERT INTO devices (id, account_id, client_device_id, name, platform, is_primary, token_hash, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			device.ID, device.AccountID, device.ClientDeviceID, device.Name, device.Platform, boolInt(device.IsPrimary), device.TokenHash, now, now)
	} else {
		device.ID = existingID
		device.CreatedAt = createdAt
		_, err = tx.ExecContext(ctx, `UPDATE devices SET name=?, platform=?, is_primary=?, token_hash=?, revoked_at=NULL, updated_at=? WHERE id=?`,
			device.Name, device.Platform, boolInt(device.IsPrimary), device.TokenHash, now, device.ID)
	}
	if err != nil {
		return Device{}, fmt.Errorf("保存设备失败: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return Device{}, err
	}
	return device, nil
}

// ListDevices 列出未撤销设备。
//
// 参数：accountID 为账号主键。
// 返回值：按创建时间升序排列。
// 注意事项：结果仍含令牌摘要，接口层必须去掉。
func (s *MySQL) ListDevices(ctx context.Context, accountID string) ([]Device, error) {
	rows, err := s.db.QueryContext(ctx, deviceSelect()+` WHERE account_id=? AND revoked_at IS NULL ORDER BY created_at ASC, id ASC`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return collectDevices(rows)
}

// GetDevice 读取一台未撤销设备。
//
// 参数：accountID 与 deviceID 必须匹配。
// 返回值：已撤销或不存在时返回 ErrNotFound。
// 注意事项：执行前用它重新确认主设备，不信任连接建立时的旧标记。
func (s *MySQL) GetDevice(ctx context.Context, accountID string, deviceID string) (Device, error) {
	rows, err := s.db.QueryContext(ctx, deviceSelect()+` WHERE account_id=? AND id=? AND revoked_at IS NULL`, accountID, deviceID)
	if err != nil {
		return Device{}, err
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return Device{}, err
		}
		return Device{}, ErrNotFound
	}
	return scanDeviceRows(rows)
}

// DeviceByTokenHash 用摘要查找有效设备及其账号。
//
// 参数：tokenHash 为 HMAC 摘要。
// 返回值：已撤销或不存在时返回 ErrNotFound。
// 注意事项：不要把摘要写入日志。
func (s *MySQL) DeviceByTokenHash(ctx context.Context, tokenHash string) (Device, Account, error) {
	row := s.db.QueryRowContext(ctx, `SELECT d.id, d.account_id, d.client_device_id, d.name, d.platform, d.is_primary, d.token_hash, d.last_seen_at, d.revoked_at, d.created_at, d.updated_at,
		a.id, a.email, a.name, a.picture, a.provider, a.created_at, a.updated_at
		FROM devices d JOIN accounts a ON a.id=d.account_id WHERE d.token_hash=? AND d.revoked_at IS NULL`, tokenHash)
	var device Device
	var account Account
	var primaryInt int
	var lastSeen, revoked sql.NullTime
	err := row.Scan(&device.ID, &device.AccountID, &device.ClientDeviceID, &device.Name, &device.Platform, &primaryInt, &device.TokenHash, &lastSeen, &revoked, &device.CreatedAt, &device.UpdatedAt,
		&account.ID, &account.Email, &account.Name, &account.Picture, &account.Provider, &account.CreatedAt, &account.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Device{}, Account{}, ErrNotFound
	}
	if err != nil {
		return Device{}, Account{}, err
	}
	device.IsPrimary = primaryInt == 1
	device.LastSeenAt = nullTimePtr(lastSeen)
	device.Revoked = revoked.Valid
	return device, account, nil
}

// TouchDevice 更新最近出现时间。
//
// 参数：deviceID 为设备主键；seenAt 为时间。
// 返回值：没有匹配行时返回 ErrNotFound。
// 注意事项：调用方应忽略失败，避免影响聊天接口。
func (s *MySQL) TouchDevice(ctx context.Context, deviceID string, seenAt time.Time) error {
	res, err := s.db.ExecContext(ctx, `UPDATE devices SET last_seen_at=?, updated_at=? WHERE id=?`, seenAt.UTC(), seenAt.UTC(), deviceID)
	if err != nil {
		return err
	}
	count, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return ErrNotFound
	}
	return nil
}

// SetPrimary 切换唯一主设备。
//
// 参数：accountID 与 deviceID 必须匹配，且设备未撤销。
// 返回值：目标不存在时返回 ErrNotFound。
// 注意事项：先清空再设置，靠账号行锁避免并发出两台主设备。
func (s *MySQL) SetPrimary(ctx context.Context, accountID string, deviceID string) error {
	return s.setPrimary(ctx, accountID, deviceID, nil, nil)
}

// SetPrimaryForSession 使用当前设备会话切换主电脑。参数：requester为认证快照，deviceID为目标；返回值：事务结果；注意事项：令牌版本在账号锁内复核，旧请求不能改变新会话配置。
func (s *MySQL) SetPrimaryForSession(ctx context.Context, requester Device, deviceID string) error {
	return s.setPrimary(ctx, requester.AccountID, deviceID, &requester, nil)
}

// setPrimary 统一处理可信内部与受认证请求的主设备变更。参数：requester为空仅供内部受信调用；返回值：变更错误；注意事项：认证与修改在同一事务。
func (s *MySQL) setPrimary(ctx context.Context, accountID string, deviceID string, requester *Device, beforeChange func() error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := lockAccount(ctx, tx, accountID); err != nil {
		return err
	}
	if err := validateRequester(ctx, tx, requester); err != nil {
		return err
	}
	var revoked sql.NullTime
	var platform string
	var isPrimary bool
	err = tx.QueryRowContext(ctx, `SELECT revoked_at, platform, is_primary FROM devices WHERE id=? AND account_id=? FOR UPDATE`, deviceID, accountID).Scan(&revoked, &platform, &isPrimary)
	if errors.Is(err, sql.ErrNoRows) || revoked.Valid || !CanExecute(platform) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if isPrimary {
		return tx.Commit()
	}
	// ------------ 先使旧配置世代失效，再提交新的唯一主电脑 ---------------
	if beforeChange != nil {
		if err := beforeChange(); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE devices SET is_primary=0 WHERE account_id=? AND revoked_at IS NULL`, accountID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE devices SET is_primary=1, updated_at=? WHERE id=?`, time.Now().UTC(), deviceID); err != nil {
		return err
	}
	return tx.Commit()
}

// RevokeDevice 撤销设备并清除其主设备身份。
//
// 参数：accountID 与 deviceID 必须匹配。
// 返回值：设备不存在或已撤销时返回 ErrNotFound。
// 注意事项：不自动提升其他设备；由用户显式选择在线电脑接管执行。
func (s *MySQL) RevokeDevice(ctx context.Context, accountID string, deviceID string) error {
	_, err := s.revokeDevice(ctx, accountID, deviceID, "", nil)
	return err
}

// RevokeSession 在账号事务内只撤销认证时对应的设备令牌版本。
//
// 参数：device 为已认证设备，TokenHash 是认证请求读取的旧令牌摘要。
// 返回值：实际撤销返回 true；令牌已轮换或已经退出返回 false。
// 注意事项：摘要为空时拒绝操作，防止不完整会话输入退化为无条件撤销。
func (s *MySQL) RevokeSession(ctx context.Context, device Device) (bool, error) {
	if device.TokenHash == "" {
		return false, ErrNotFound
	}
	return s.revokeDevice(ctx, device.AccountID, device.ID, device.TokenHash, nil)
}

// revokeDevice 在账号行锁下撤销设备并维护唯一主设备。
//
// 参数：accountID 与 deviceID 限定目标；expectedHash 为空表示管理撤销，非空表示退出对应的会话版本。
// 返回值：是否实际撤销以及事务错误。
// 注意事项：旧退出请求不更新设备或主设备；数据库更新仍带令牌条件，零影响行按旧会话幂等处理。
func (s *MySQL) revokeDevice(ctx context.Context, accountID, deviceID, expectedHash string, requester *Device) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()
	if err := lockAccount(ctx, tx, accountID); err != nil {
		return false, err
	}
	if err := validateRequester(ctx, tx, requester); err != nil {
		return false, err
	}
	var revoked sql.NullTime
	var tokenHash string
	err = tx.QueryRowContext(ctx, `SELECT revoked_at, token_hash FROM devices WHERE id=? AND account_id=? FOR UPDATE`, deviceID, accountID).Scan(&revoked, &tokenHash)
	if errors.Is(err, sql.ErrNoRows) || revoked.Valid {
		if expectedHash != "" {
			return false, nil
		}
		return false, ErrNotFound
	}
	if err != nil {
		return false, err
	}
	// ------------ 比对会话版本后执行条件撤销 ---------------
	if expectedHash != "" && tokenHash != expectedHash {
		return false, nil
	}
	now := time.Now().UTC()
	result, err := tx.ExecContext(ctx, `UPDATE devices SET revoked_at=?, is_primary=0, updated_at=? WHERE id=? AND account_id=? AND token_hash=? AND revoked_at IS NULL`, now, now, deviceID, accountID, tokenHash)
	if err != nil {
		return false, err
	}
	updated, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	if updated == 0 {
		if expectedHash != "" {
			return false, nil
		}
		return false, ErrNotFound
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}

// InsertInvite 保存邀请码摘要。
//
// 参数：invite 只含摘要和有效期。
// 返回值：写入错误。
// 注意事项：明文邀请码不能入库。
func (s *MySQL) InsertInvite(ctx context.Context, invite Invite) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO invites (code_hash, account_id, created_by_device, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`,
		invite.CodeHash, invite.AccountID, invite.CreatedByDevice, invite.ExpiresAt.UTC(), invite.CreatedAt.UTC())
	if err != nil {
		return fmt.Errorf("保存邀请码失败: %w", err)
	}
	return nil
}

// ConsumeInvite 核销邀请码。
//
// 参数：codeHash 为摘要；now 为当前时间。
// 返回值：账号 ID，或未找到、已使用、已过期错误。
// 注意事项：核销与后续设备登记是两个事务，邀请码先失效，避免重复加入。
func (s *MySQL) ConsumeInvite(ctx context.Context, codeHash string, now time.Time) (string, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback() }()
	var accountID string
	var expiresAt time.Time
	var usedAt sql.NullTime
	err = tx.QueryRowContext(ctx, `SELECT account_id, expires_at, used_at FROM invites WHERE code_hash=? FOR UPDATE`, codeHash).Scan(&accountID, &expiresAt, &usedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	if usedAt.Valid {
		return "", ErrInviteUsed
	}
	if !expiresAt.After(now) {
		return "", ErrInviteExpired
	}
	if _, err := tx.ExecContext(ctx, `UPDATE invites SET used_at=? WHERE code_hash=?`, now.UTC(), codeHash); err != nil {
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	return accountID, nil
}

// WithAccount 锁定账号后执行聊天和任务修改。
//
// 参数：fn 返回错误时回滚事务。
// 返回值：fn 或数据库错误。
// 注意事项：fn 内只能使用传入的 Tx。
func (s *MySQL) WithAccount(ctx context.Context, accountID string, fn func(Tx) error) (err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	if err = lockAccount(ctx, tx, accountID); err != nil {
		return err
	}
	if err = fn(&mysqlTx{tx: tx, accountID: accountID}); err != nil {
		return err
	}
	return tx.Commit()
}

// LoadState 读取聊天快照。
//
// 参数：accountID 为账号主键。
// 返回值：没有行时返回版本 0 的空结构。
// 注意事项：供设备拉取全量记录。
func (s *MySQL) LoadState(ctx context.Context, accountID string) (State, error) {
	return scanState(s.db.QueryRowContext(ctx, `SELECT revision, body, updated_by_device, updated_at FROM chat_states WHERE account_id=?`, accountID))
}

// ListPending 列出待主设备执行的任务。
//
// 参数：accountID 为账号主键。
// 返回值：pending 与 running 任务，最多 100 条。
// 注意事项：按创建时间升序，先到先执行。
func (s *MySQL) ListPending(ctx context.Context, accountID string) ([]Dispatch, error) {
	rows, err := s.db.QueryContext(ctx, dispatchSelect()+` WHERE account_id=? AND status IN ('pending', 'running') ORDER BY created_at ASC LIMIT 100`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return collectDispatches(rows)
}

// FindDispatch 按账号读取单个任务。
//
// 参数：accountID 限定租户；dispatchID 为任务主键。
// 返回值：不存在时返回 ErrNotFound。
// 注意事项：不能跨账号读取。
func (s *MySQL) FindDispatch(ctx context.Context, accountID string, dispatchID string) (Dispatch, error) {
	item, err := scanDispatch(s.db.QueryRowContext(ctx, dispatchSelect()+` WHERE account_id=? AND id=?`, accountID, dispatchID))
	if errors.Is(err, sql.ErrNoRows) {
		return Dispatch{}, ErrNotFound
	}
	return item, err
}

// mysqlTx 在账号事务内修改聊天记录和任务。
type mysqlTx struct {
	tx        *sql.Tx
	accountID string
}

// State 读取事务内可见的快照。
//
// 参数：ctx 控制取消。
// 返回值：当前快照。
// 注意事项：必须运行在 WithAccount 内。
func (t *mysqlTx) State(ctx context.Context) (State, error) {
	return scanState(t.tx.QueryRowContext(ctx, `SELECT revision, body, updated_by_device, updated_at FROM chat_states WHERE account_id=?`, t.accountID))
}

// SaveState 把快照版本加一后写回。
//
// 参数：deviceID 为来源设备；body 为完整 JSON。
// 返回值：新快照。
// 注意事项：调用方已在同一事务里比对过版本。
func (t *mysqlTx) SaveState(ctx context.Context, deviceID string, body []byte) (State, error) {
	now := time.Now().UTC()
	var updated any
	if deviceID != "" {
		updated = deviceID
	}
	res, err := t.tx.ExecContext(ctx, `UPDATE chat_states SET revision=revision+1, body=?, updated_by_device=?, updated_at=? WHERE account_id=?`, string(body), updated, now, t.accountID)
	if err != nil {
		return State{}, err
	}
	count, err := res.RowsAffected()
	if err != nil {
		return State{}, err
	}
	if count == 0 {
		return State{}, ErrNotFound
	}
	return t.State(ctx)
}

// FindDispatchByClientRequest 按幂等键查找任务。
//
// 参数：clientRequestID 为客户端请求号。
// 返回值：不存在时返回 nil, nil。
// 注意事项：可以看到本事务刚插入的任务。
func (t *mysqlTx) FindDispatchByClientRequest(ctx context.Context, clientRequestID string) (*Dispatch, error) {
	item, err := scanDispatch(t.tx.QueryRowContext(ctx, dispatchSelect()+` WHERE account_id=? AND client_request_id=?`, t.accountID, clientRequestID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

// InsertDispatch 在当前事务插入任务。
//
// 参数：item 为完整任务。
// 返回值：数据库错误。
// 注意事项：账号必须与事务账号一致。
func (t *mysqlTx) InsertDispatch(ctx context.Context, item Dispatch) error {
	_, err := t.tx.ExecContext(ctx, `INSERT INTO dispatches (id, account_id, source_device_id, client_request_id, mode, room_id, user_text, payload, status, result, error_message, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		item.ID, t.accountID, item.SourceDeviceID, item.ClientRequestID, item.Mode, item.RoomID, item.UserText, string(item.Payload), item.Status, nullableText(item.Result), item.ErrorMessage, item.CreatedAt.UTC(), item.UpdatedAt.UTC())
	return err
}

// FindDispatch 在事务内按主键查找。
//
// 参数：id 为任务主键。
// 返回值：不存在时返回 nil, nil。
// 注意事项：限定当前账号。
func (t *mysqlTx) FindDispatch(ctx context.Context, id string) (*Dispatch, error) {
	item, err := scanDispatch(t.tx.QueryRowContext(ctx, dispatchSelect()+` WHERE account_id=? AND id=?`, t.accountID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

// SaveDispatch 更新任务状态、结果和错误。
//
// 参数：item 为完整新值。
// 返回值：没有匹配行时返回 ErrNotFound。
// 注意事项：不修改创建时间和所属设备。
func (t *mysqlTx) SaveDispatch(ctx context.Context, item Dispatch) error {
	res, err := t.tx.ExecContext(ctx, `UPDATE dispatches SET status=?, result=?, error_message=?, updated_at=? WHERE id=? AND account_id=?`,
		item.Status, nullableText(item.Result), item.ErrorMessage, item.UpdatedAt.UTC(), item.ID, t.accountID)
	if err != nil {
		return err
	}
	count, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return ErrNotFound
	}
	return nil
}

// lockAccount 锁定账号行，串行化该账号的设备与聊天修改。
//
// 参数：tx 为当前事务；accountID 为账号主键。
// 返回值：账号不存在时返回 ErrNotFound。
// 注意事项：必须在修改设备主身份或聊天快照前调用。
func lockAccount(ctx context.Context, tx *sql.Tx, accountID string) error {
	var id string
	err := tx.QueryRowContext(ctx, `SELECT id FROM accounts WHERE id=? FOR UPDATE`, accountID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

// scanAccount 从单行结果读取账号。
//
// 参数：row 为查询结果。
// 返回值：账号或查询错误。
// 注意事项：列顺序必须与 SELECT 一致。
func scanAccount(row *sql.Row) (Account, error) {
	var account Account
	err := row.Scan(&account.ID, &account.Email, &account.Name, &account.Picture, &account.Provider, &account.CreatedAt, &account.UpdatedAt)
	return account, err
}

// scanState 读取快照行；没有行时返回空聊天结构。
//
// 参数：row 为查询结果。
// 返回值：快照或错误。
// 注意事项：正文复制为独立字节切片。
func scanState(row *sql.Row) (State, error) {
	var state State
	var body string
	var updatedBy sql.NullString
	err := row.Scan(&state.Revision, &body, &updatedBy, &state.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return State{Revision: 0, Body: []byte(emptyState)}, nil
	}
	if err != nil {
		return State{}, err
	}
	state.Body = []byte(body)
	if updatedBy.Valid {
		state.UpdatedBy = updatedBy.String
	}
	return state, nil
}

// deviceSelect 返回设备查询列。
//
// 参数：无。
// 返回值：以 SELECT 开头、不含 WHERE 的 SQL。
// 注意事项：列顺序必须与 scanDevice 一致。
func deviceSelect() string {
	return `SELECT id, account_id, client_device_id, name, platform, is_primary, token_hash, last_seen_at, revoked_at, created_at, updated_at FROM devices`
}

// collectDevices 读取全部设备行。
//
// 参数：rows 为已执行的查询。
// 返回值：设备列表。
// 注意事项：调用方负责关闭 rows。
func collectDevices(rows *sql.Rows) ([]Device, error) {
	items := make([]Device, 0)
	for rows.Next() {
		device, err := scanDeviceRows(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, device)
	}
	return items, rows.Err()
}

// scanDeviceRows 从多行结果读取一台设备。
//
// 参数：rows 指向当前行。
// 返回值：设备或扫描错误。
// 注意事项：已撤销标记来自 revoked_at 是否有值。
func scanDeviceRows(rows *sql.Rows) (Device, error) {
	var device Device
	var primaryInt int
	var lastSeen, revoked sql.NullTime
	err := rows.Scan(&device.ID, &device.AccountID, &device.ClientDeviceID, &device.Name, &device.Platform, &primaryInt, &device.TokenHash, &lastSeen, &revoked, &device.CreatedAt, &device.UpdatedAt)
	if err != nil {
		return Device{}, err
	}
	device.IsPrimary = primaryInt == 1
	device.LastSeenAt = nullTimePtr(lastSeen)
	device.Revoked = revoked.Valid
	return device, nil
}

// dispatchSelect 返回任务查询列。
//
// 参数：无。
// 返回值：不含 WHERE 的 SELECT 语句。
// 注意事项：列顺序必须与 scanDispatch 一致。
func dispatchSelect() string {
	return `SELECT id, account_id, source_device_id, client_request_id, mode, room_id, user_text, payload, status, result, error_message, created_at, updated_at FROM dispatches`
}

// collectDispatches 读取任务列表。
//
// 参数：rows 为查询结果。
// 返回值：任务副本。
// 注意事项：调用方负责关闭 rows。
func collectDispatches(rows *sql.Rows) ([]Dispatch, error) {
	items := make([]Dispatch, 0)
	for rows.Next() {
		item, err := scanDispatchRows(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// scanDispatch 读取单行任务。
//
// 参数：row 为查询结果。
// 返回值：任务或 sql.ErrNoRows。
// 注意事项：空结果列转换成 nil 字节切片。
func scanDispatch(row *sql.Row) (Dispatch, error) {
	var item Dispatch
	var payload, userText string
	var result sql.NullString
	err := row.Scan(&item.ID, &item.AccountID, &item.SourceDeviceID, &item.ClientRequestID, &item.Mode, &item.RoomID, &userText, &payload, &item.Status, &result, &item.ErrorMessage, &item.CreatedAt, &item.UpdatedAt)
	if err != nil {
		return Dispatch{}, err
	}
	item.UserText = userText
	item.Payload = []byte(payload)
	if result.Valid {
		item.Result = []byte(result.String)
	}
	return item, nil
}

// scanDispatchRows 从多行结果读取任务。
//
// 参数：rows 指向当前行。
// 返回值：任务或扫描错误。
// 注意事项：与 scanDispatch 的列顺序相同。
func scanDispatchRows(rows *sql.Rows) (Dispatch, error) {
	var item Dispatch
	var payload, userText string
	var result sql.NullString
	err := rows.Scan(&item.ID, &item.AccountID, &item.SourceDeviceID, &item.ClientRequestID, &item.Mode, &item.RoomID, &userText, &payload, &item.Status, &result, &item.ErrorMessage, &item.CreatedAt, &item.UpdatedAt)
	if err != nil {
		return Dispatch{}, err
	}
	item.UserText = userText
	item.Payload = []byte(payload)
	if result.Valid {
		item.Result = []byte(result.String)
	}
	return item, nil
}

// nullableText 把空结果存成 NULL。
//
// 参数：body 为 JSON 字节。
// 返回值：可绑定到 SQL 的值。
// 注意事项：空切片和 nil 都写成 NULL。
func nullableText(body []byte) any {
	if len(body) == 0 {
		return nil
	}
	return string(body)
}

// nullTimePtr 把可空时间转成指针。
//
// 参数：value 为扫描结果。
// 返回值：无值时返回 nil。
// 注意事项：返回的时间是副本。
func nullTimePtr(value sql.NullTime) *time.Time {
	if !value.Valid {
		return nil
	}
	copied := value.Time
	return &copied
}

// boolInt 把布尔值转成 MySQL TINYINT。
//
// 参数：value 为业务布尔值。
// 返回值：1 或 0。
// 注意事项：读取时再转回布尔，避免驱动对 TINYINT 的差异。
func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

// safeDBName 再次校验数据库名，避免 DDL 注入。
//
// 参数：name 为库名。
// 返回值：合法时返回 true。
// 注意事项：规则与配置解析保持一致。
func safeDBName(name string) bool {
	if name == "" || len(name) > 64 {
		return false
	}
	for _, r := range name {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '_' {
			return false
		}
	}
	return true
}

// RegisterEmail 原子创建账号、密码摘要和空快照；已有邮箱不覆盖资料或凭据。
func (s *MySQL) RegisterEmail(ctx context.Context, account Account, passwordHash string) (Account, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Account{}, err
	}
	defer tx.Rollback()
	now := time.Now().UTC()
	_, err = tx.ExecContext(ctx, `INSERT INTO accounts (id,email,name,picture,provider,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`, account.ID, account.Email, account.Name, account.Picture, account.Provider, now, now)
	if err != nil {
		var mysqlErr *mysql.MySQLError
		if errors.As(err, &mysqlErr) && mysqlErr.Number == 1062 {
			return Account{}, ErrAccountExists
		}
		return Account{}, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO account_credentials (account_id,password_hash,created_at) VALUES (?,?,?)`, account.ID, passwordHash, now); err != nil {
		return Account{}, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO chat_states (account_id,revision,body,updated_at) VALUES (?,0,?,?)`, account.ID, emptyState, now); err != nil {
		return Account{}, err
	}
	if err = tx.Commit(); err != nil {
		return Account{}, err
	}
	account.CreatedAt = now
	account.UpdatedAt = now
	return account, nil
}
func (s *MySQL) PasswordHash(ctx context.Context, accountID string) (string, error) {
	var hash string
	err := s.db.QueryRowContext(ctx, `SELECT password_hash FROM account_credentials WHERE account_id=?`, accountID).Scan(&hash)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return hash, err
}
func (t *mysqlTx) Device(ctx context.Context, deviceID string) (Device, error) {
	rows, err := t.tx.QueryContext(ctx, deviceSelect()+` WHERE account_id=? AND id=? AND revoked_at IS NULL`, t.accountID, deviceID)
	if err != nil {
		return Device{}, err
	}
	defer rows.Close()
	if !rows.Next() {
		if rows.Err() != nil {
			return Device{}, rows.Err()
		}
		return Device{}, ErrNotFound
	}
	return scanDeviceRows(rows)
}
func (t *mysqlTx) Pending(ctx context.Context) ([]Dispatch, error) {
	rows, err := t.tx.QueryContext(ctx, dispatchSelect()+` WHERE account_id=? AND status IN ('pending','running') ORDER BY created_at ASC,id ASC LIMIT 100`, t.accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return collectDispatches(rows)
}
func (t *mysqlTx) Claim(ctx context.Context, dispatchID string) (Claim, error) {
	var c Claim
	err := t.tx.QueryRowContext(ctx, `SELECT dispatch_id,device_id,token_hash,expires_at FROM dispatch_claims WHERE dispatch_id=?`, dispatchID).Scan(&c.DispatchID, &c.DeviceID, &c.TokenHash, &c.ExpiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Claim{}, ErrNotFound
	}
	return c, err
}
func (t *mysqlTx) SaveClaim(ctx context.Context, c Claim) error {
	_, err := t.tx.ExecContext(ctx, `INSERT INTO dispatch_claims (dispatch_id,device_id,token_hash,expires_at) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE device_id=VALUES(device_id),token_hash=VALUES(token_hash),expires_at=VALUES(expires_at)`, c.DispatchID, c.DeviceID, c.TokenHash, c.ExpiresAt.UTC())
	return err
}

var stringIDType = regexp.MustCompile(`^(?:var)?char\([1-9][0-9]{0,3}\)$`)

// foreignIDDefinition 从旧表实际定义构造外键列，兼容历史部署的 MySQL 排序规则。
func (s *MySQL) foreignIDDefinition(ctx context.Context, table string) (string, error) {
	var columnType, charset, collation string
	err := s.db.QueryRowContext(ctx, `SELECT COLUMN_TYPE,CHARACTER_SET_NAME,COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME='id'`, table).Scan(&columnType, &charset, &collation)
	if err != nil {
		return "", fmt.Errorf("读取外键引用列定义失败 table=%s: %w", table, err)
	}
	if !stringIDType.MatchString(columnType) || !safeDBName(charset) || !safeDBName(collation) {
		return "", fmt.Errorf("外键引用列不是支持的字符串 UUID 类型 table=%s", table)
	}
	return strings.ToUpper(columnType) + " CHARACTER SET " + charset + " COLLATE " + collation, nil
}
