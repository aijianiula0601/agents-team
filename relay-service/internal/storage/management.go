package storage

import (
	"context"
	"time"
)

// MaxOverviewDays 限制趋势查询和补零序列长度，包含首尾日期，避免无界时间扫描和响应。
const MaxOverviewDays = 366

// Release 保存安装包及其发布状态。参数：字段来自后台校验后的上传；返回值：对外版本元数据；注意事项：StorageKey 仅供服务端访问，不能暴露绝对路径。
type Release struct {
	ID            string     `json:"id"`
	Platform      string     `json:"platform"`
	Arch          string     `json:"arch"`
	Version       string     `json:"version"`
	BuildNumber   int64      `json:"buildNumber"`
	Notes         string     `json:"notes"`
	FileName      string     `json:"fileName"`
	Size          int64      `json:"size"`
	SHA256        string     `json:"sha256"`
	StorageKey    string     `json:"-"`
	StoragePath   string     `json:"storagePath,omitempty"`
	Status        string     `json:"status"`
	CreatedBy     string     `json:"-"`
	CreatedAt     time.Time  `json:"createdAt"`
	PublishedAt   *time.Time `json:"publishedAt"`
	DownloadCount int64      `json:"downloadCount"`
	DownloadURL   string     `json:"downloadUrl"`
}

// ManagementStore 提供后台所需的有界查询与版本持久化。参数：accountID 为空仅代表已授权管理员全局范围；返回值：分页数据或错误；注意事项：不得向列表返回密码、令牌、聊天正文。
type ManagementStore interface {
	Store
	AccountManager
	ManagementOverview(context.Context, string, time.Time, time.Time) (map[string]any, error)
	ManagementList(context.Context, string, string, string, string, int, int) ([]map[string]any, int64, error)
	SaveRelease(context.Context, Release) error
	FindRelease(context.Context, string) (Release, error)
	ListReleases(context.Context, bool, string, int, int) ([]Release, int64, error)
	SetReleaseStatus(context.Context, string, string) (Release, error)
	LatestReleases(context.Context, string, string) ([]Release, error)
	CountDownload(context.Context, string) error
}
