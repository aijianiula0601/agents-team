package storage

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"agents-team-relay/internal/config"
)

// TestMySQLMigrationForeignKeys 验证实际存储迁移及外键字符集兼容性。默认跳过；需显式连接测试实例。
func TestMySQLMigrationForeignKeys(t *testing.T) {
	if os.Getenv("RELAY_INTEGRATION_TEST") != "1" {
		t.Skip("set RELAY_INTEGRATION_TEST=1 with the test storage configuration")
	}
	_, source, _, _ := runtime.Caller(0)
	root := filepath.Clean(filepath.Join(filepath.Dir(source), "../.."))
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(root); err != nil {
		t.Fatal(err)
	}
	defer os.Chdir(cwd)
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load test configuration: %v", err)
	}
	if cfg.Env != "test" {
		t.Fatal("integration migration requires RELAY_ENV=test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	store, err := OpenMySQL(ctx, cfg.MySQL)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	for _, pair := range []struct{ table, column, referenced string }{{"account_credentials", "account_id", "accounts"}, {"dispatch_claims", "dispatch_id", "dispatches"}} {
		var mismatches int
		err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM information_schema.COLUMNS child JOIN information_schema.COLUMNS parent ON parent.TABLE_SCHEMA=child.TABLE_SCHEMA AND parent.TABLE_NAME=? AND parent.COLUMN_NAME='id' WHERE child.TABLE_SCHEMA=DATABASE() AND child.TABLE_NAME=? AND child.COLUMN_NAME=? AND (child.COLUMN_TYPE<>parent.COLUMN_TYPE OR child.CHARACTER_SET_NAME<>parent.CHARACTER_SET_NAME OR child.COLLATION_NAME<>parent.COLLATION_NAME)`, pair.referenced, pair.table, pair.column).Scan(&mismatches)
		if err != nil || mismatches != 0 {
			t.Fatalf("foreign key column compatibility %s.%s: mismatches=%d err=%v", pair.table, pair.column, mismatches, err)
		}
		var constraints int
		err = store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? AND REFERENCED_TABLE_NAME=? AND REFERENCED_COLUMN_NAME='id'`, pair.table, pair.column, pair.referenced).Scan(&constraints)
		if err != nil || constraints != 1 {
			t.Fatalf("foreign key missing %s.%s: constraints=%d err=%v", pair.table, pair.column, constraints, err)
		}
	}
}

// TestMySQLSessionLogoutFence 验证实际MySQL事务中的令牌版本撤销与内存实现保持一致。
// 参数：t 为测试句柄。
// 返回值：无，存储契约错误时终止测试。
// 注意事项：必须显式开启集成验收，只创建随机隔离.test账号，不操作真实用户。
func TestMySQLSessionLogoutFence(t *testing.T) {
	if os.Getenv("RELAY_INTEGRATION_TEST") != "1" {
		t.Skip("set RELAY_INTEGRATION_TEST=1 with the test storage configuration")
	}
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	root := cwd
	if _, err := os.Stat(filepath.Join(root, ".env.test")); os.IsNotExist(err) {
		// 本机go test从包目录启动，服务器编译后验收则直接从部署目录启动。
		_, source, _, _ := runtime.Caller(0)
		root = filepath.Clean(filepath.Join(filepath.Dir(source), "../.."))
	}
	if err := os.Chdir(root); err != nil {
		t.Fatal(err)
	}
	defer os.Chdir(cwd)
	cfg, err := config.Load()
	if err != nil || cfg.Env != "test" {
		t.Fatal("必须使用测试存储配置")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	store, err := OpenMySQL(ctx, cfg.MySQL)
	if err != nil {
		t.Fatal("测试MySQL初始化失败")
	}
	defer store.Close()
	verifySessionLogoutFence(t, store)
}
