// Package main 启动 Chorus 聊天中转服务。
package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"agents-team-relay/internal/config"
	"agents-team-relay/internal/httpapi"
	"agents-team-relay/internal/identity"
	"agents-team-relay/internal/logx"
	"agents-team-relay/internal/management"
	"agents-team-relay/internal/realtime"
	"agents-team-relay/internal/service"
	"agents-team-relay/internal/storage"

	"github.com/redis/go-redis/v9"
)

// main 按配置连接 MySQL、Redis 并监听 HTTP。
//
// 参数：无。环境由 RELAY_ENV 选择。
// 返回值：无。初始化失败时进程退出。
// 注意事项：收到停止信号后最多等待 20 秒排空请求。
func main() {
	logx.Infof("------------- 加载配置 --------------")
	cfg, err := config.Load()
	if err != nil {
		logx.Errorf("加载配置失败 err=%v", err)
		os.Exit(1)
	}
	logx.SetLevel(cfg.LogLevel)
	logx.Infof("配置已加载 env=%s listen=%s prefix=%s mysql_host=%s redis=%s", cfg.Env, cfg.ListenAddr, cfg.RoutePrefix, cfg.MySQL.Host, cfg.Redis.Addr)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	logx.Infof("------------- 连接 MySQL --------------")
	store, err := storage.OpenMySQL(ctx, cfg.MySQL)
	if err != nil {
		logx.Errorf("MySQL 初始化失败 err=%v", err)
		os.Exit(1)
	}
	defer store.Close()

	logx.Infof("------------- 连接 Redis --------------")
	redisClient := redis.NewClient(&redis.Options{
		Addr:     cfg.Redis.Addr,
		Username: cfg.Redis.Username,
		Password: cfg.Redis.Password,
		DB:       cfg.Redis.DB,
	})
	pingCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	err = redisClient.Ping(pingCtx).Err()
	cancel()
	if err != nil {
		logx.Errorf("Redis 连接失败 addr=%s", cfg.Redis.Addr)
		os.Exit(1)
	}
	logx.Infof("Redis 已就绪 addr=%s db=%d prefix=%s", cfg.Redis.Addr, cfg.Redis.DB, cfg.Redis.Prefix)
	defer redisClient.Close()

	hub := realtime.New(redisClient, cfg.Redis.Prefix)
	go hub.Run(ctx)
	svc := service.New(store, identity.NewGoogle(cfg.GoogleUserInfo, cfg.GoogleTimeout), hub, cfg.TokenKey, cfg.StateLimit).WithAccessPolicy(identity.AccessPolicy{GoogleEmail: cfg.GoogleSuperadminEmail, EmployeeID: cfg.SuperadminEmployeeID})

	logx.Infof("------------- 初始化管理后台与版本发布 --------------")
	admin := management.New(store, hub, management.Config{Prefix: cfg.RoutePrefix, PublicURL: cfg.PublicURL, AdminEmails: cfg.AdminEmails, AdminPasswordHash: cfg.AdminPasswordHash, SuperadminEmail: cfg.ManagementSuperadminEmail, SuperadminPasswordHash: cfg.ManagementSuperadminPasswordHash, ProtectedGoogleEmail: cfg.GoogleSuperadminEmail, ReleaseDir: cfg.ReleaseDir, StorageID: cfg.ReleaseStorageID, Peers: cfg.ReleasePeers, SelfURL: cfg.ReleaseSelf, WriterURL: cfg.ReleaseWriter, HostDir: cfg.ReleaseHostDir, Nodes: cfg.ReleaseNodes, SyncKey: management.SyncKeyFromToken(cfg.TokenKey), MaxUploadBytes: cfg.ReleaseMaxBytes})
	if !admin.StorageAvailable() {
		logx.Warnf("版本发布暂不可用：安装包目录或卷标识未配置/不可访问；统计后台仍可使用")
	} else {
		logx.Infof("版本发布目录已启用 peers=%d", len(cfg.ReleasePeers))
	}

	server := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           httpapi.New(svc, store, hub, cfg.RoutePrefix).WithOAuth(httpapi.OAuthConfig{ClientID: cfg.GoogleClientID, ClientSecret: cfg.GoogleClientSecret, PublicURL: cfg.PublicURL, TokenKey: cfg.TokenKey, Timeout: cfg.GoogleTimeout}).WithManagement(admin).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	logx.Infof("------------- 启动服务 --------------")
	errCh := make(chan error, 1)
	go func() {
		serveErr := server.ListenAndServe()
		if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			errCh <- serveErr
		}
	}()
	logx.Infof("服务已监听 addr=%s health=%s/health", cfg.ListenAddr, cfg.RoutePrefix)

	select {
	case <-ctx.Done():
		logx.Infof("------------- 停止服务 --------------")
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer shutdownCancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			logx.Errorf("停止服务失败 err=%v", err)
			os.Exit(1)
		}
	case err := <-errCh:
		logx.Errorf("服务异常退出 err=%v", err)
		os.Exit(1)
	}
}
