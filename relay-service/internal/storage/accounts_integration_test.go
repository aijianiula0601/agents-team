package storage

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"agents-team-relay/internal/config"
	"github.com/google/uuid"
)

// TestAccountManagementMySQLIntegration 在独立临时库验证账号变更的真实外键事务。参数：t为测试句柄；返回值：无；注意事项：只在显式开启集成测试时使用.env.test连接，绝不修改已有业务库。
func TestAccountManagementMySQLIntegration(t *testing.T) {
	if os.Getenv("RELAY_MANAGEMENT_INTEGRATION") != "1" {
		t.Skip("设置 RELAY_MANAGEMENT_INTEGRATION=1 RELAY_ENV=test 才运行独立临时库验收")
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
		t.Fatal("账号集成测试必须使用测试环境配置")
	}
	cfg.MySQL.DBName = "relay_accounts_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	admin, err := sql.Open("mysql", cfg.MySQL.DSN(""))
	if err != nil {
		t.Fatal("打开测试数据库连接失败")
	}
	defer admin.Close()
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := admin.ExecContext(ctx, "DROP DATABASE IF EXISTS `"+cfg.MySQL.DBName+"`"); err != nil {
			t.Error("清理随机临时数据库失败", err)
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	store, err := OpenMySQL(ctx, cfg.MySQL)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	// 模拟旧版本数据库，在真实在线DDL路径升级并核对口令未丢失。
	legacy, err := store.RegisterEmail(ctx, Account{ID: uuid.NewString(), Email: "legacy@example.test", Name: "旧版用户", Provider: "email"}, "legacy-password-hash")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.db.ExecContext(ctx, "ALTER TABLE account_credentials DROP COLUMN auth_version"); err != nil {
		t.Fatal(err)
	}
	if err = store.migrateCredentialVersion(ctx); err != nil {
		t.Fatal("升级历史凭据表失败", err)
	}
	if hash, version, err := store.PasswordState(ctx, legacy.ID); err != nil || hash != "legacy-password-hash" || version != 0 {
		t.Fatal("迁移破坏历史凭据", err)
	}
	// 模拟双节点均曾看到列不存在：第二个节点重复ADD得到1060后须核对定义并成功。
	if err = store.addCredentialVersion(ctx); err != nil {
		t.Fatal("并发重复列迁移未幂等处理", err)
	}
	deleted, other := verifyAccountManagement(t, store)
	// ------------ 核对所有关联表已清理且另一个账号仍完整存在 ---------------
	for _, query := range []string{"SELECT COUNT(*) FROM accounts WHERE id=?", "SELECT COUNT(*) FROM devices WHERE account_id=?", "SELECT COUNT(*) FROM chat_states WHERE account_id=?", "SELECT COUNT(*) FROM account_credentials WHERE account_id=?", "SELECT COUNT(*) FROM invites WHERE account_id=?", "SELECT COUNT(*) FROM dispatches WHERE account_id=?"} {
		var count int
		if err = store.db.QueryRowContext(ctx, query, deleted).Scan(&count); err != nil || count != 0 {
			t.Fatal("删除事务残留关联数据", count, err)
		}
		if err = store.db.QueryRowContext(ctx, query, other).Scan(&count); err != nil || count != 1 {
			t.Fatal("删除影响其他账号关联数据", count, err)
		}
	}
	var orphanClaims int
	if err = store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM dispatch_claims c LEFT JOIN dispatches d ON d.id=c.dispatch_id WHERE d.id IS NULL`).Scan(&orphanClaims); err != nil || orphanClaims != 0 {
		t.Fatal("租约外键清理不完整", orphanClaims, err)
	}
}
