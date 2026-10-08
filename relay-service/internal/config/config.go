// Package config 读取环境文件和进程配置。
package config

import (
	"bufio"
	"encoding/hex"
	"fmt"
	"net/mail"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
	"golang.org/x/crypto/bcrypt"
)

// Config 是中转站进程配置。
//
// 参数：GoogleSuperadminEmail 与 SuperadminEmployeeID 绑定服务器授权的 Google 员工身份；其他字段配置监听、认证及存储。
// 返回值：由 Load 或 Parse 构造。
// 注意事项：密码、令牌密钥与授权邮箱配置不能进入日志或公开配置接口。
type Config struct {
	Env                              string
	ListenAddr                       string
	RoutePrefix                      string
	LogLevel                         string
	TokenKey                         []byte
	GoogleTimeout                    time.Duration
	GoogleUserInfo                   string
	GoogleClientID                   string
	GoogleClientSecret               string
	GoogleSuperadminEmail            string
	SuperadminEmployeeID             string
	PublicURL                        string
	StateLimit                       int
	MySQL                            MySQLConfig
	AdminEmails                      []string
	AdminPasswordHash                string
	ManagementSuperadminEmail        string
	ManagementSuperadminPasswordHash string
	ReleaseDir                       string
	ReleaseStorageID                 string
	ReleasePeers                     []string
	ReleaseSelf                      string
	ReleaseWriter                    string
	ReleaseHostDir                   string
	ReleaseNodes                     []string
	ReleaseMaxBytes                  int64
	Redis                            RedisConfig
}

// MySQLConfig 是共享 MySQL 连接参数。
type MySQLConfig struct {
	Host     string
	Port     int
	User     string
	Password string
	DBName   string
}

// RedisConfig 是共享 Redis 连接参数。
type RedisConfig struct {
	Addr     string
	Username string
	Password string
	DB       int
	Prefix   string
}

// Load 从环境变量和对应的 .env 文件加载配置。
//
// 参数：无。先读 RELAY_ENV，再读 .env.<env>，进程环境变量优先于文件。
// 返回值：校验后的配置；缺必填项时返回错误。
// 注意事项：不会把密码和密钥写入日志。
func Load() (Config, error) {
	envName := firstNonEmpty(os.Getenv("RELAY_ENV"), "dev")
	fileValues, err := readEnvFile(".env." + envName)
	if err != nil {
		return Config{}, err
	}
	values := map[string]string{}
	for key, value := range fileValues {
		values[key] = value
	}
	for _, item := range os.Environ() {
		key, value, ok := strings.Cut(item, "=")
		if ok {
			values[key] = value
		}
	}
	values["RELAY_ENV"] = envName
	return Parse(values)
}

// Parse 根据已合并的键值解析配置。
//
// 参数：values 为环境变量表，进程环境应已覆盖文件。
// 返回值：校验后的配置或错误。
// 注意事项：test 和 prod 必须显式提供 64 位十六进制令牌密钥。
func Parse(values map[string]string) (Config, error) {
	envName := firstNonEmpty(values["RELAY_ENV"], "dev")
	if envName != "dev" && envName != "test" && envName != "prod" {
		return Config{}, fmt.Errorf("RELAY_ENV 只能是 dev、test 或 prod")
	}
	port, err := parseInt(firstNonEmpty(values["RELAY_MYSQL_PORT"], "3306"), 1, 65535, "RELAY_MYSQL_PORT")
	if err != nil {
		return Config{}, err
	}
	redisDB, err := parseInt(firstNonEmpty(values["RELAY_REDIS_DB"], "0"), 0, 15, "RELAY_REDIS_DB")
	if err != nil {
		return Config{}, err
	}
	timeoutSec, err := parseInt(firstNonEmpty(values["RELAY_GOOGLE_TIMEOUT_SECONDS"], "8"), 1, 30, "RELAY_GOOGLE_TIMEOUT_SECONDS")
	if err != nil {
		return Config{}, err
	}
	stateLimit, err := parseInt(firstNonEmpty(values["RELAY_STATE_LIMIT_BYTES"], "1500000"), 1024, 32_000_000, "RELAY_STATE_LIMIT_BYTES")
	if err != nil {
		return Config{}, err
	}
	tokenHex := strings.TrimSpace(values["RELAY_TOKEN_KEY"])
	if tokenHex == "" && envName == "dev" {
		tokenHex = strings.Repeat("ab", 32)
	}
	tokenKey, err := decodeTokenKey(tokenHex, envName)
	if err != nil {
		return Config{}, err
	}
	prefix := strings.Trim(firstNonEmpty(values["RELAY_ROUTE_PREFIX"], "/agents-team"), "/")
	if prefix == "" || strings.Contains(prefix, "/") {
		return Config{}, fmt.Errorf("RELAY_ROUTE_PREFIX 必须是单段路径，例如 /agents-team")
	}
	redisPrefix := strings.TrimSpace(firstNonEmpty(values["RELAY_REDIS_KEY_PREFIX"], "agents-team:"+envName))
	if strings.ContainsAny(redisPrefix, " \t{}") {
		return Config{}, fmt.Errorf("RELAY_REDIS_KEY_PREFIX 不能包含空白或花括号")
	}
	dbName := strings.TrimSpace(firstNonEmpty(values["RELAY_MYSQL_DB"], "agents_team_relay"))
	if !safeIdent(dbName) {
		return Config{}, fmt.Errorf("RELAY_MYSQL_DB 只能包含字母、数字和下划线")
	}
	// ------------ 公开地址由部署者指定，开发环境仅回退到本机服务 ---------------
	publicURL := strings.TrimRight(firstNonEmpty(values["RELAY_PUBLIC_URL"], values["RELAY_GOOGLE_PUBLIC_URL"]), "/")
	if publicURL == "" {
		if envName != "dev" {
			return Config{}, fmt.Errorf("test/prod 环境必须配置 RELAY_PUBLIC_URL")
		}
		publicURL = "http://127.0.0.1:5006/" + prefix
	}
	cfg := Config{
		Env:                   envName,
		ListenAddr:            firstNonEmpty(values["RELAY_LISTEN_ADDR"], ":5006"),
		RoutePrefix:           "/" + prefix,
		LogLevel:              firstNonEmpty(values["RELAY_LOG_LEVEL"], "INFO"),
		TokenKey:              tokenKey,
		GoogleTimeout:         time.Duration(timeoutSec) * time.Second,
		GoogleUserInfo:        firstNonEmpty(values["RELAY_GOOGLE_USERINFO_URL"], "https://www.googleapis.com/oauth2/v3/userinfo"),
		StateLimit:            stateLimit,
		GoogleClientID:        strings.TrimSpace(values["RELAY_GOOGLE_CLIENT_ID"]),
		GoogleClientSecret:    values["RELAY_GOOGLE_CLIENT_SECRET"],
		GoogleSuperadminEmail: strings.ToLower(strings.TrimSpace(values["RELAY_GOOGLE_SUPERADMIN_EMAIL"])),
		SuperadminEmployeeID:  strings.TrimSpace(values["RELAY_SUPERADMIN_EMPLOYEE_ID"]),
		PublicURL:             publicURL,
		MySQL: MySQLConfig{
			Host:     strings.TrimSpace(firstNonEmpty(values["RELAY_MYSQL_HOST"], "127.0.0.1")),
			Port:     port,
			User:     strings.TrimSpace(firstNonEmpty(values["RELAY_MYSQL_USER"], "root")),
			Password: values["RELAY_MYSQL_PASSWORD"],
			DBName:   dbName,
		},
		Redis: RedisConfig{
			Addr:     strings.TrimSpace(firstNonEmpty(values["RELAY_REDIS_ADDR"], "127.0.0.1:6379")),
			Username: values["RELAY_REDIS_USERNAME"],
			Password: values["RELAY_REDIS_PASSWORD"],
			DB:       redisDB,
			Prefix:   redisPrefix,
		},
	}
	// ------------ 校验服务器员工身份映射 ---------------
	if (cfg.GoogleSuperadminEmail == "") != (cfg.SuperadminEmployeeID == "") {
		return Config{}, fmt.Errorf("超级管理员 Google 邮箱和工号必须同时配置")
	}
	if cfg.GoogleSuperadminEmail != "" {
		address, err := mail.ParseAddress(cfg.GoogleSuperadminEmail)
		if err != nil || address.Address != cfg.GoogleSuperadminEmail || len(cfg.GoogleSuperadminEmail) > 254 {
			return Config{}, fmt.Errorf("RELAY_GOOGLE_SUPERADMIN_EMAIL 必须是单个有效邮箱")
		}
		if len(cfg.SuperadminEmployeeID) > 32 || strings.Trim(cfg.SuperadminEmployeeID, "0123456789") != "" {
			return Config{}, fmt.Errorf("RELAY_SUPERADMIN_EMPLOYEE_ID 必须是 1 到 32 位数字")
		}
	}
	if cfg.MySQL.Host == "" || cfg.MySQL.User == "" {
		return Config{}, fmt.Errorf("MySQL 主机和用户不能为空")
	}
	if cfg.Redis.Addr == "" {
		return Config{}, fmt.Errorf("Redis 地址不能为空")
	}
	if envName != "dev" && (cfg.MySQL.Password == "" || cfg.Redis.Password == "") {
		return Config{}, fmt.Errorf("%s 环境必须配置 MySQL 和 Redis 密码", envName)
	}

	// ------------ 校验后台预置身份与共享安装包配置 ---------------
	cfg.AdminPasswordHash = strings.TrimSpace(values["RELAY_ADMIN_PASSWORD_HASH"])
	for _, email := range strings.Split(values["RELAY_ADMIN_EMAILS"], ",") {
		email = strings.ToLower(strings.TrimSpace(email))
		if email == "" {
			continue
		}
		address, parseErr := mail.ParseAddress(email)
		if parseErr != nil || address.Address != email || len(email) > 254 {
			return Config{}, fmt.Errorf("RELAY_ADMIN_EMAILS 必须为逗号分隔的有效邮箱")
		}
		cfg.AdminEmails = append(cfg.AdminEmails, email)
	}
	if (len(cfg.AdminEmails) > 0) != (cfg.AdminPasswordHash != "") {
		return Config{}, fmt.Errorf("RELAY_ADMIN_EMAILS 与 RELAY_ADMIN_PASSWORD_HASH 必须同时配置")
	}
	if cfg.AdminPasswordHash != "" {
		if _, err := bcrypt.Cost([]byte(cfg.AdminPasswordHash)); err != nil {
			return Config{}, fmt.Errorf("RELAY_ADMIN_PASSWORD_HASH 必须为有效 bcrypt 摘要")
		}
	}
	// ------------ 独立配置后台超级管理员，不复用共享管理员口令 ---------------
	cfg.ManagementSuperadminEmail = strings.ToLower(strings.TrimSpace(values["RELAY_MANAGEMENT_SUPERADMIN_EMAIL"]))
	cfg.ManagementSuperadminPasswordHash = strings.TrimSpace(values["RELAY_MANAGEMENT_SUPERADMIN_PASSWORD_HASH"])
	if cfg.ManagementSuperadminPasswordHash != "" && cfg.ManagementSuperadminEmail == "" {
		cfg.ManagementSuperadminEmail = cfg.GoogleSuperadminEmail
	}
	if (cfg.ManagementSuperadminEmail != "") != (cfg.ManagementSuperadminPasswordHash != "") {
		return Config{}, fmt.Errorf("后台超级管理员邮箱与独立bcrypt摘要必须同时配置")
	}
	if cfg.ManagementSuperadminEmail != "" {
		address, err := mail.ParseAddress(cfg.ManagementSuperadminEmail)
		if err != nil || address.Address != cfg.ManagementSuperadminEmail || len(cfg.ManagementSuperadminEmail) > 254 {
			return Config{}, fmt.Errorf("RELAY_MANAGEMENT_SUPERADMIN_EMAIL 必须为有效邮箱")
		}
		if _, err = bcrypt.Cost([]byte(cfg.ManagementSuperadminPasswordHash)); err != nil {
			return Config{}, fmt.Errorf("RELAY_MANAGEMENT_SUPERADMIN_PASSWORD_HASH 必须为有效bcrypt摘要")
		}
		if cfg.ManagementSuperadminPasswordHash == cfg.AdminPasswordHash {
			return Config{}, fmt.Errorf("超级管理员必须使用独立于普通管理员的口令摘要")
		}
	}
	cfg.ReleaseDir = strings.TrimSpace(values["RELAY_RELEASE_DIR"])
	cfg.ReleaseStorageID = strings.TrimSpace(values["RELAY_RELEASE_STORAGE_ID"])
	if len(cfg.ReleaseStorageID) > 128 || strings.ContainsAny(cfg.ReleaseStorageID, " \t\r\n") {
		return Config{}, fmt.Errorf("RELAY_RELEASE_STORAGE_ID 必须是不含空白的1到128字节标识")
	}
	if cfg.ReleaseDir != "" && envName != "dev" && cfg.ReleaseStorageID == "" {
		return Config{}, fmt.Errorf("test/prod 配置 RELAY_RELEASE_DIR 时必须提供 RELAY_RELEASE_STORAGE_ID 共享卷标识")
	}
	if cfg.ReleaseDir != "" && !filepath.IsAbs(cfg.ReleaseDir) {
		return Config{}, fmt.Errorf("RELAY_RELEASE_DIR 必须为绝对路径；多节点应使用同一共享挂载")
	}
	cfg.ReleasePeers, err = parseReleasePeers(values["RELAY_RELEASE_PEERS"])
	if err != nil {
		return Config{}, err
	}
	cfg.ReleaseSelf, err = parseReleaseSelf(values["RELAY_RELEASE_SELF"])
	if err != nil {
		return Config{}, err
	}
	cfg.ReleaseWriter, err = parseReleaseSelf(values["RELAY_RELEASE_WRITER"])
	if err != nil {
		return Config{}, fmt.Errorf("RELAY_RELEASE_WRITER 必须是单个 http(s)://主机:端口")
	}
	cfg.ReleaseHostDir = strings.TrimSpace(values["RELAY_RELEASE_HOST_DIR"])
	if cfg.ReleaseHostDir != "" && !filepath.IsAbs(cfg.ReleaseHostDir) {
		return Config{}, fmt.Errorf("RELAY_RELEASE_HOST_DIR 必须为绝对路径")
	}
	cfg.ReleaseNodes, err = parseReleaseNodes(values["RELAY_RELEASE_NODES"])
	if err != nil {
		return Config{}, err
	}
	limit, err := parseInt(firstNonEmpty(values["RELAY_RELEASE_MAX_BYTES"], "2147483648"), 1048576, 2147483648, "RELAY_RELEASE_MAX_BYTES")
	if err != nil {
		return Config{}, err
	}
	cfg.ReleaseMaxBytes = int64(limit)
	return cfg, nil
}

// parseReleasePeers 解析安装包同步节点。
//
// 参数：raw 为逗号分隔的源站，可为空。
// 返回值：去重后的 http(s) 源站，或格式错误。
// 注意事项：只接受主机和端口，拒绝路径、账号和查询串，避免把同步请求转到任意地址。
func parseReleasePeers(raw string) ([]string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	parts := strings.Split(raw, ",")
	peers := make([]string, 0, len(parts))
	seen := map[string]struct{}{}
	for _, part := range parts {
		origin, err := parseReleaseOrigin(part)
		if err != nil {
			return nil, fmt.Errorf("RELAY_RELEASE_PEERS 必须是逗号分隔的 http(s)://主机:端口")
		}
		if _, ok := seen[origin]; ok {
			continue
		}
		seen[origin] = struct{}{}
		peers = append(peers, origin)
	}
	if len(peers) > 8 {
		return nil, fmt.Errorf("RELAY_RELEASE_PEERS 最多 8 个节点")
	}
	return peers, nil
}

// parseReleaseNodes 解析安装包所在的服务器地址。
//
// 参数：raw 为逗号分隔的主机名或 IP，可为空。
// 返回值：去重后的节点列表，或格式错误。
// 注意事项：只用于管理页展示和手动上传说明，不作为请求转发地址。
func parseReleaseNodes(raw string) ([]string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	parts := strings.Split(raw, ",")
	nodes := make([]string, 0, len(parts))
	seen := map[string]struct{}{}
	for _, part := range parts {
		host := strings.TrimSpace(part)
		if host == "" || len(host) > 253 || strings.ContainsAny(host, " \t/\\") {
			return nil, fmt.Errorf("RELAY_RELEASE_NODES 必须是逗号分隔的主机名或 IP")
		}
		if _, ok := seen[host]; ok {
			continue
		}
		seen[host] = struct{}{}
		nodes = append(nodes, host)
	}
	if len(nodes) > 8 {
		return nil, fmt.Errorf("RELAY_RELEASE_NODES 最多 8 个节点")
	}
	return nodes, nil
}

// parseReleaseSelf 解析本机源站。
//
// 参数：raw 为本机对外地址，可为空。
// 返回值：规范化源站；空输入返回空字符串。
// 注意事项：用于跳过把自己的安装包再同步给自己。
func parseReleaseSelf(raw string) (string, error) {
	if strings.TrimSpace(raw) == "" {
		return "", nil
	}
	origin, err := parseReleaseOrigin(raw)
	if err != nil {
		return "", fmt.Errorf("RELAY_RELEASE_SELF 必须是单个 http(s)://主机:端口")
	}
	return origin, nil
}

// parseReleaseOrigin 规范化单个源站。
//
// 参数：raw 为配置中的一个地址。
// 返回值：scheme://host，或格式错误。
// 注意事项：不保留用户信息、路径、查询和片段。
func parseReleaseOrigin(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return "", fmt.Errorf("invalid origin")
	}
	return parsed.Scheme + "://" + parsed.Host, nil
}

// DSN 生成指定库名的 MySQL DSN。
//
// 参数：dbName 为空时不选择数据库，用于启动前建库。
// 返回值：go-sql-driver 可直接打开的 DSN。
// 注意事项：密码中的特殊字符由驱动编码，调用方不要自行拼接。
func (c MySQLConfig) DSN(dbName string) string {
	driver := mysql.NewConfig()
	driver.User = c.User
	driver.Passwd = c.Password
	driver.Net = "tcp"
	driver.Addr = fmt.Sprintf("%s:%d", c.Host, c.Port)
	driver.DBName = dbName
	driver.ParseTime = true
	driver.Loc = time.UTC
	driver.Timeout = 8 * time.Second
	driver.ReadTimeout = 30 * time.Second
	driver.WriteTimeout = 30 * time.Second
	driver.Params = map[string]string{"charset": "utf8mb4"}
	driver.AllowNativePasswords = true
	return driver.FormatDSN()
}

// decodeTokenKey 把十六进制密钥解码为 HMAC 密钥。
//
// 参数：tokenHex 为配置原文；envName 用于错误提示。
// 返回值：32 字节密钥或错误。
// 注意事项：test/prod 拒绝空值和开发占位值以外的非法长度。
func decodeTokenKey(tokenHex string, envName string) ([]byte, error) {
	if tokenHex == "" {
		return nil, fmt.Errorf("%s 环境必须配置 64 位十六进制 RELAY_TOKEN_KEY", envName)
	}
	if len(tokenHex) != 64 {
		return nil, fmt.Errorf("RELAY_TOKEN_KEY 必须是 64 位十六进制")
	}
	key, err := hex.DecodeString(tokenHex)
	if err != nil {
		return nil, fmt.Errorf("RELAY_TOKEN_KEY 必须是十六进制")
	}
	return key, nil
}

// readEnvFile 读取 KEY=VALUE 环境文件。
//
// 参数：path 为文件路径。文件不存在时返回空表。
// 返回值：键值表；格式错误时返回错误。
// 注意事项：以 # 开头的行是注释。值中的 # 会保留。
func readEnvFile(path string) (map[string]string, error) {
	file, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]string{}, nil
		}
		return nil, fmt.Errorf("读取环境文件失败: %w", err)
	}
	defer file.Close()
	values := map[string]string{}
	scanner := bufio.NewScanner(file)
	lineNo := 0
	for scanner.Scan() {
		lineNo++
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok || strings.TrimSpace(key) == "" {
			return nil, fmt.Errorf("环境文件 %s 第 %d 行不是 KEY=VALUE", path, lineNo)
		}
		values[strings.TrimSpace(key)] = strings.TrimSpace(value)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("读取环境文件失败: %w", err)
	}
	return values, nil
}

// parseInt 解析有界整数配置。
//
// 参数：raw 为原文；min 和 max 为闭区间；name 用于错误信息。
// 返回值：整数或错误。
// 注意事项：空字符串由调用方先填默认值。
func parseInt(raw string, min int, max int, name string) (int, error) {
	value, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || value < min || value > max {
		return 0, fmt.Errorf("%s 必须是 %d 到 %d 的整数", name, min, max)
	}
	return value, nil
}

// firstNonEmpty 返回第一个非空白字符串。
//
// 参数：values 按优先级排列。
// 返回值：命中的字符串；都为空时返回空字符串。
// 注意事项：不会去掉调用方已经判定过的内部空格以外的内容。
func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

// safeIdent 判断数据库名是否可安全拼进 DDL。
//
// 参数：name 为数据库名。
// 返回值：仅含字母、数字和下划线时返回 true。
// 注意事项：建库语句不能使用占位符，调用前必须通过本函数。
func safeIdent(name string) bool {
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
