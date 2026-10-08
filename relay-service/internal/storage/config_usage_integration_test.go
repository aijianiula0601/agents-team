package storage

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"agents-team-relay/internal/config"
)

// TestConfigUsageMySQLIntegration 验证配置保护的真实 JSON SQL 及完整队列查询。
//
// 参数：t 为测试句柄；RELAY_CONFIG_INTEGRATION=1 和 RELAY_ENV=test 显式启用。
// 返回值：无；真实 SQL、账号或状态过滤错误时失败。
// 注意事项：仅使用连接内临时表遮蔽同名业务表，显式 DROP TEMPORARY 清理，绝不修改真实 dispatches。
func TestConfigUsageMySQLIntegration(t *testing.T) {
	if os.Getenv("RELAY_CONFIG_INTEGRATION") != "1" {
		t.Skip("设置 RELAY_CONFIG_INTEGRATION=1 RELAY_ENV=test 才连接测试 MySQL 临时表")
	}
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	root := cwd
	if _, err := os.Stat(filepath.Join(root, ".env.test")); os.IsNotExist(err) {
		_, source, _, _ := runtime.Caller(0)
		root = filepath.Clean(filepath.Join(filepath.Dir(source), "../.."))
	}
	if err := os.Chdir(root); err != nil {
		t.Fatal(err)
	}
	defer os.Chdir(cwd)
	cfg, err := config.Load()
	if err != nil || cfg.Env != "test" {
		t.Fatal("配置 SQL 验收必须使用测试环境配置")
	}
	db, err := sql.Open("mysql", cfg.MySQL.DSN(cfg.MySQL.DBName))
	if err != nil {
		t.Fatal("打开测试 MySQL 连接失败")
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal("连接测试 MySQL 事务失败")
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `CREATE TEMPORARY TABLE dispatches (id VARCHAR(128) PRIMARY KEY, account_id VARCHAR(128), status VARCHAR(32), room_id VARCHAR(128), payload LONGTEXT, KEY(account_id,status))`); err != nil {
		t.Fatal("创建连接内临时表失败", err)
	}
	defer tx.ExecContext(context.Background(), `DROP TEMPORARY TABLE IF EXISTS dispatches`)
	for index := 0; index < 101; index++ {
		if _, err := tx.ExecContext(ctx, `INSERT INTO dispatches VALUES (?, 'owned', 'pending', '', '{"agentId":"other"}')`, index); err != nil {
			t.Fatal(err)
		}
	}
	for _, scenario := range []struct {
		account string
		status  string
		room    string
		payload string
		busy    bool
	}{
		{"owned", "pending", "", `{"agentId":"target"}`, true},
		{"owned", "running", "", `{"responders":[{"agentId":"target"}]}`, true},
		{"owned", "pending", "room-target", `{}`, true},
		{"owned", "pending", "other-room", `{"responders":[{"agentId":"target"}]}`, false},
		{"other", "pending", "", `{"agentId":"target"}`, false},
		{"owned", "done", "", `{"agentId":"target"}`, false},
		{"owned", "failed", "room-target", `{}`, false},
	} {
		if _, err := tx.ExecContext(ctx, `INSERT INTO dispatches VALUES ('target', ?, ?, ?, ?) ON DUPLICATE KEY UPDATE account_id=VALUES(account_id),status=VALUES(status),room_id=VALUES(room_id),payload=VALUES(payload)`, scenario.account, scenario.status, scenario.room, scenario.payload); err != nil {
			t.Fatal(err)
		}
		busy, err := (&mysqlTx{tx: tx, accountID: "owned"}).ConfigInUse(ctx, "target", []string{"room-target"})
		if err != nil || busy != scenario.busy {
			t.Fatalf("配置 SQL 判定错误: expected=%t actual=%t error=%v", scenario.busy, busy, err)
		}
	}
}
