// Package logx 提供进程内单例日志。
package logx

import (
	"log"
	"os"
	"strings"
	"sync"
)

var (
	instance *log.Logger
	once     sync.Once
	levelMu  sync.RWMutex
	minLevel = levelInfo
)

const (
	levelDebug = iota
	levelInfo
	levelWarn
	levelError
)

// Instance 返回全局日志器。
//
// 参数：无。
// 返回值：写入标准输出的单例 Logger。
// 注意事项：初始化只发生一次，后续只调整级别，不替换输出目标。
func Instance() *log.Logger {
	once.Do(func() {
		instance = log.New(os.Stdout, "", log.LstdFlags|log.LUTC)
	})
	return instance
}

// SetLevel 设置最低输出级别。
//
// 参数：level 为 DEBUG、INFO、WARN、ERROR，不区分大小写。
// 返回值：无。
// 注意事项：无法识别时回退为 INFO。
func SetLevel(level string) {
	levelMu.Lock()
	defer levelMu.Unlock()
	switch strings.ToUpper(strings.TrimSpace(level)) {
	case "DEBUG":
		minLevel = levelDebug
	case "WARN", "WARNING":
		minLevel = levelWarn
	case "ERROR":
		minLevel = levelError
	default:
		minLevel = levelInfo
	}
}

// enabled 判断目标级别是否达到当前阈值。
//
// 参数：target 为内部级别常量。
// 返回值：允许输出时返回 true。
// 注意事项：调用方需先判断再格式化敏感参数以外的内容。
func enabled(target int) bool {
	levelMu.RLock()
	defer levelMu.RUnlock()
	return target >= minLevel
}

// Debugf 记录调试日志。
//
// 参数：format 与 args 为标准库格式化参数。
// 返回值：无。
// 注意事项：不得传入令牌、密码或完整环境变量。
func Debugf(format string, args ...any) {
	if enabled(levelDebug) {
		Instance().Printf("DEBUG agents_team_relay "+format, args...)
	}
}

// Infof 记录流程日志。
//
// 参数：format 与 args 为标准库格式化参数。
// 返回值：无。
// 注意事项：关键阶段使用固定中文阶段名，便于检索。
func Infof(format string, args ...any) {
	if enabled(levelInfo) {
		Instance().Printf("INFO agents_team_relay "+format, args...)
	}
}

// Warnf 记录可恢复异常。
//
// 参数：format 与 args 为标准库格式化参数。
// 返回值：无。
// 注意事项：不得输出原始令牌。
func Warnf(format string, args ...any) {
	if enabled(levelWarn) {
		Instance().Printf("WARN agents_team_relay "+format, args...)
	}
}

// Errorf 记录失败日志。
//
// 参数：format 与 args 为标准库格式化参数。
// 返回值：无。
// 注意事项：错误文本由调用方脱敏后再传入。
func Errorf(format string, args ...any) {
	if enabled(levelError) {
		Instance().Printf("ERROR agents_team_relay "+format, args...)
	}
}
