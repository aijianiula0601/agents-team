package config

import "testing"

// TestParseDevDefaults 确认开发环境可以使用内置密钥启动。
//
// 参数：t 为测试句柄。
// 返回值：无。
// 注意事项：不读取仓库里的真实环境文件。
func TestParseDevDefaults(t *testing.T) {
	cfg, err := Parse(map[string]string{"RELAY_ENV": "dev"})
	if err != nil {
		t.Fatalf("开发配置解析失败: %v", err)
	}
	if cfg.RoutePrefix != "/agents-team" {
		t.Fatalf("路径前缀错误: %s", cfg.RoutePrefix)
	}
	if len(cfg.TokenKey) != 32 {
		t.Fatalf("开发密钥长度错误: %d", len(cfg.TokenKey))
	}
	if cfg.MySQL.DSN("agents_team_relay") == "" {
		t.Fatal("DSN 不应为空")
	}
	if cfg.PublicURL != "http://127.0.0.1:5006/agents-team" {
		t.Fatalf("开发环境公开地址不应指向外部服务: %s", cfg.PublicURL)
	}
}

// TestParseTestRequiresPublicURL 确认测试服务必须由部署者指定公开地址。
//
// 参数：t 为测试句柄。
// 返回值：无。
// 注意事项：只使用合成密码与令牌，不连接数据库或网络。
func TestParseTestRequiresPublicURL(t *testing.T) {
	values := map[string]string{"RELAY_ENV": "test", "RELAY_TOKEN_KEY": "abababababababababababababababababababababababababababababababab", "RELAY_MYSQL_PASSWORD": "test-only", "RELAY_REDIS_PASSWORD": "test-only"}
	if _, err := Parse(values); err == nil {
		t.Fatal("测试环境缺少公开地址时应该失败")
	}
	values["RELAY_PUBLIC_URL"] = "https://relay.example.test/agents-team"
	if cfg, err := Parse(values); err != nil || cfg.PublicURL != values["RELAY_PUBLIC_URL"] {
		t.Fatalf("显式公开地址未生效: %v", err)
	}
}

// TestParseTestRequiresSecrets 确认测试环境拒绝空密码和空密钥。
//
// 参数：t 为测试句柄。
// 返回值：无。
// 注意事项：错误信息不得包含密码原文，本用例也不提供密码。
func TestParseTestRequiresSecrets(t *testing.T) {
	_, err := Parse(map[string]string{"RELAY_ENV": "test"})
	if err == nil {
		t.Fatal("测试环境缺少密钥时应该失败")
	}
}

// TestParseSuperadminIdentity 验证服务器员工身份配置必须完整且格式合法。
//
// 参数：t 为测试句柄。
// 返回值：无；错误配置被接受时终止测试。
// 注意事项：测试只使用内存配置，不读取真实环境文件或个人邮箱。
func TestParseSuperadminIdentity(t *testing.T) {
	for _, item := range []struct {
		email    string
		employee string
		valid    bool
	}{
		{"", "", true},
		{" ADMIN@EXAMPLE.TEST ", " 12345678 ", true},
		{"admin@example.test", "", false},
		{"", "12345678", false},
		{"Admin <admin@example.test>", "12345678", false},
		{"admin@example.test,other@example.test", "12345678", false},
		{"not-an-email", "12345678", false},
		{"admin@example.test", "12user", false},
		{"admin@example.test", "123456789012345678901234567890123", false},
	} {
		cfg, err := Parse(map[string]string{"RELAY_ENV": "dev", "RELAY_GOOGLE_SUPERADMIN_EMAIL": item.email, "RELAY_SUPERADMIN_EMPLOYEE_ID": item.employee})
		if (err == nil) != item.valid {
			t.Fatalf("配置校验与预期不符 valid=%t", item.valid)
		}
		if err == nil && item.employee != "" && (cfg.GoogleSuperadminEmail != "admin@example.test" || cfg.SuperadminEmployeeID != "12345678") {
			t.Fatal("员工配置未去除空白或规范化邮箱")
		}
	}
}

// TestManagementConfiguration 验证新增配置兼容默认启动且拒绝不完整管理员配置。参数：t为测试句柄；返回值：无；注意事项：测试摘要仅用于语法校验，不读取环境口令。
func TestManagementConfiguration(t *testing.T) {
	hash := "$2a$10$7EqJtq98hPqEX7fNZaFWoO5jEWtF2hV0HGbQ9q1GyCKshizT8oL8K"
	for _, values := range []map[string]string{
		{"RELAY_ADMIN_EMAILS": "admin@example.test"},
		{"RELAY_ADMIN_PASSWORD_HASH": hash},
		{"RELAY_ADMIN_EMAILS": "admin@example.test", "RELAY_ADMIN_PASSWORD_HASH": "plaintext"},
		{"RELAY_RELEASE_DIR": "relative/path"},
		{"RELAY_RELEASE_MAX_BYTES": "2147483649"},
	} {
		if _, err := Parse(values); err == nil {
			t.Fatal("不安全后台配置被接受")
		}
	}
	cfg, err := Parse(map[string]string{"RELAY_ADMIN_EMAILS": " ADMIN@example.test,second@example.test ", "RELAY_ADMIN_PASSWORD_HASH": hash, "RELAY_RELEASE_DIR": "/mnt/releases"})
	if err != nil || len(cfg.AdminEmails) != 2 || cfg.AdminEmails[0] != "admin@example.test" || cfg.ReleaseMaxBytes != 2147483648 {
		t.Fatal("后台配置解析错误", err)
	}
	cfg, err = Parse(map[string]string{})
	if err != nil || cfg.ReleaseDir != "" || len(cfg.AdminEmails) != 0 {
		t.Fatal("默认后台配置破坏兼容性", err)
	}
}

// TestProductionReleaseRequiresSharedIdentity 验证正式环境必须预置共享卷标识。参数：t为测试句柄；返回值：无；注意事项：所有口令与密钥为本测试的无效占位，不读取真实配置。
func TestProductionReleaseRequiresSharedIdentity(t *testing.T) {
	values := map[string]string{"RELAY_ENV": "test", "RELAY_TOKEN_KEY": "abababababababababababababababababababababababababababababababab", "RELAY_MYSQL_PASSWORD": "test-only", "RELAY_REDIS_PASSWORD": "test-only", "RELAY_PUBLIC_URL": "https://relay.example.test/agents-team", "RELAY_RELEASE_DIR": "/mnt/releases"}
	if _, err := Parse(values); err == nil {
		t.Fatal("正式发布目录未要求卷标识")
	}
	values["RELAY_RELEASE_STORAGE_ID"] = "volume-test"
	values["RELAY_RELEASE_PEERS"] = "http://10.0.0.8:5006,http://10.0.0.9:5006/"
	values["RELAY_RELEASE_SELF"] = "http://10.0.0.8:5006"
	values["RELAY_RELEASE_WRITER"] = "http://10.0.0.9:5006"
	values["RELAY_RELEASE_HOST_DIR"] = "/data/agents-team-releases"
	values["RELAY_RELEASE_NODES"] = "10.0.0.8,10.0.0.9"
	cfg, err := Parse(values)
	if err != nil || cfg.ReleaseStorageID != "volume-test" || len(cfg.ReleasePeers) != 2 || cfg.ReleasePeers[1] != "http://10.0.0.9:5006" || cfg.ReleaseSelf != "http://10.0.0.8:5006" || cfg.ReleaseWriter != "http://10.0.0.9:5006" || cfg.ReleaseHostDir != "/data/agents-team-releases" || len(cfg.ReleaseNodes) != 2 {
		t.Fatal("共享卷配置被拒绝", err)
	}
	values["RELAY_RELEASE_HOST_DIR"] = "releases"
	if _, err = Parse(values); err == nil {
		t.Fatal("相对安装包目录被接受")
	}
	values["RELAY_RELEASE_HOST_DIR"] = "/data/agents-team-releases"
	values["RELAY_RELEASE_NODES"] = "10.0.0.8/releases"
	if _, err = Parse(values); err == nil {
		t.Fatal("带路径的节点地址被接受")
	}
	values["RELAY_RELEASE_NODES"] = "10.0.0.8,10.0.0.9"
	values["RELAY_RELEASE_PEERS"] = "http://files.example/releases"
	if _, err = Parse(values); err == nil {
		t.Fatal("带路径的同步地址被接受")
	}
}

// TestManagementSuperadminConfiguration 验证后台超级管理员身份必须来自可信且独立的配置。参数：t为测试句柄；返回值：无；注意事项：Google邮箱仅在显式配置超级管理员口令后作为回退，不自动升级任何已注册用户。
func TestManagementSuperadminConfiguration(t *testing.T) {
	hash := "$2a$10$7EqJtq98hPqEX7fNZaFWoO5jEWtF2hV0HGbQ9q1GyCKshizT8oL8K"
	for _, values := range []map[string]string{
		{"RELAY_MANAGEMENT_SUPERADMIN_EMAIL": "owner@example.test"},
		{"RELAY_MANAGEMENT_SUPERADMIN_PASSWORD_HASH": hash},
		{"RELAY_MANAGEMENT_SUPERADMIN_EMAIL": "not-email", "RELAY_MANAGEMENT_SUPERADMIN_PASSWORD_HASH": hash},
		{"RELAY_MANAGEMENT_SUPERADMIN_EMAIL": "owner@example.test", "RELAY_MANAGEMENT_SUPERADMIN_PASSWORD_HASH": "plaintext"},
		{"RELAY_ADMIN_EMAILS": "admin@example.test", "RELAY_ADMIN_PASSWORD_HASH": hash, "RELAY_MANAGEMENT_SUPERADMIN_EMAIL": "owner@example.test", "RELAY_MANAGEMENT_SUPERADMIN_PASSWORD_HASH": hash},
	} {
		if _, err := Parse(values); err == nil {
			t.Fatal("不完整或复用口令的超级管理员配置被接受")
		}
	}
	cfg, err := Parse(map[string]string{"RELAY_MANAGEMENT_SUPERADMIN_EMAIL": " OWNER@example.test ", "RELAY_MANAGEMENT_SUPERADMIN_PASSWORD_HASH": hash})
	if err != nil || cfg.ManagementSuperadminEmail != "owner@example.test" {
		t.Fatal("独立超级管理员配置失败", err)
	}
	google := map[string]string{"RELAY_GOOGLE_SUPERADMIN_EMAIL": "verified@example.test", "RELAY_SUPERADMIN_EMPLOYEE_ID": "12345678"}
	cfg, err = Parse(google)
	if err != nil || cfg.ManagementSuperadminEmail != "" {
		t.Fatal("Google配置自动启用了后台密码超级管理员", err)
	}
	google["RELAY_MANAGEMENT_SUPERADMIN_PASSWORD_HASH"] = hash
	cfg, err = Parse(google)
	if err != nil || cfg.ManagementSuperadminEmail != "verified@example.test" {
		t.Fatal("受信Google邮箱回退失败", err)
	}
}
