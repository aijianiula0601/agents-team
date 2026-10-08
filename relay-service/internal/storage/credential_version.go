package storage

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"time"

	"github.com/go-sql-driver/mysql"
)

// migrateCredentialVersion 为已有密码凭据增加持久认证版本。参数：ctx限制迁移耗时；返回值：迁移错误；注意事项：独立连接设置短元数据锁等待和在线DDL，恢复会话配置失败时丢弃连接，不阻塞正常业务连接池。
func (s *MySQL) migrateCredentialVersion(ctx context.Context) error {
	ready, err := credentialVersionReady(ctx, s.db)
	if err != nil {
		return err
	}
	if ready {
		return nil
	}

	return s.addCredentialVersion(ctx)
}

// addCredentialVersion 以在线DDL添加认证版本并容忍另一个节点先完成迁移。参数：ctx限制运行时间；返回值：DDL或定义校验错误；注意事项：1060只在重新核对列定义一致后作为成功。
func (s *MySQL) addCredentialVersion(ctx context.Context) error {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	var original int
	if err = conn.QueryRowContext(ctx, "SELECT @@SESSION.lock_wait_timeout").Scan(&original); err != nil {
		return err
	}
	if _, err = conn.ExecContext(ctx, "SET SESSION lock_wait_timeout=2"); err != nil {
		return err
	}
	defer func() {
		restore, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if _, err := conn.ExecContext(restore, "SET SESSION lock_wait_timeout=?", original); err != nil {
			_ = conn.Raw(func(any) error { return driver.ErrBadConn })
		}
	}()
	_, err = conn.ExecContext(ctx, `ALTER TABLE account_credentials ADD COLUMN auth_version BIGINT NOT NULL DEFAULT 0, ALGORITHM=INPLACE, LOCK=NONE`)
	var duplicate *mysql.MySQLError
	if errors.As(err, &duplicate) && duplicate.Number == 1060 {
		ready, checkErr := credentialVersionReady(ctx, conn)
		if checkErr != nil {
			return checkErr
		}
		if ready {
			return nil
		}
	}
	return err
}

// PasswordState 一次查询获取密码摘要与持久认证版本。参数：accountID为账号主键；返回值：密码摘要、版本及错误；注意事项：必须在密码验证之前读取快照，避免重置后给旧认证结果绑定新版本。
func (s *MySQL) PasswordState(ctx context.Context, accountID string) (string, int64, error) {
	var hash string
	var version int64
	err := s.db.QueryRowContext(ctx, `SELECT password_hash,auth_version FROM account_credentials WHERE account_id=?`, accountID).Scan(&hash, &version)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return hash, version, err
}

// PasswordState 原子读取内存中的密码和认证版本。参数：accountID为主键；返回值：摘要、版本或不存在错误；注意事项：与邮箱变更、密码重置持有同一互斥锁。
func (m *Memory) PasswordState(_ context.Context, accountID string) (string, int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	hash, ok := m.passwords[accountID]
	if !ok {
		return "", 0, ErrNotFound
	}
	return hash, m.authVersions[accountID], nil
}

// credentialVersionReady 核对认证版本列存在且符合预期定义。参数：query为当前数据库或专用连接；返回值：已正确迁移与错误；注意事项：双节点同时升级遇到1060时必须验证列定义，不能盲目吞掉DDL错误。
func credentialVersionReady(ctx context.Context, query interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}) (bool, error) {
	var dataType, nullable string
	var defaultValue sql.NullString
	err := query.QueryRowContext(ctx, `SELECT DATA_TYPE,IS_NULLABLE,COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='account_credentials' AND COLUMN_NAME='auth_version'`).Scan(&dataType, &nullable, &defaultValue)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if dataType != "bigint" || nullable != "NO" || !defaultValue.Valid || defaultValue.String != "0" {
		return false, fmt.Errorf("account_credentials.auth_version定义不符合BIGINT NOT NULL DEFAULT 0")
	}
	return true, nil
}
