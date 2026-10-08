package management

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"agents-team-relay/internal/logx"
	"agents-team-relay/internal/storage"
	"github.com/google/uuid"
)

var versionPattern = regexp.MustCompile(`^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$`)

// validTarget 判断支持的平台和架构。参数：platform/arch 为规范标识；返回值：是否合法；注意事项：universal 表示同平台通用包。
func validTarget(platform, arch string) bool {
	return (platform == "mac" || platform == "android") && (arch == "arm64" || arch == "x64" || arch == "universal")
}

// withDownloadURL 填充公开相对下载地址。参数：item 为数据库记录；返回值：可序列化记录；注意事项：地址保持同源，反向代理前缀由配置控制。
func (s *Server) withDownloadURL(item storage.Release) storage.Release {
	item.DownloadURL = s.cfg.Prefix + "/api/v1/releases/" + item.ID + "/download"
	return item
}

// releases 分页展示版本历史。参数：浏览器认证请求；返回值：管理员全部状态或普通账号已发布版本；注意事项：草稿不得通过公开更新接口暴露。
func (s *Server) releases(w http.ResponseWriter, r *http.Request) {
	session, ok := s.authenticate(w, r, false)
	if !ok {
		return
	}
	page, size := pagination(r)
	items, total, err := s.store.ListReleases(r.Context(), isAdministrator(session.User.Role), r.URL.Query().Get("platform"), page, size)
	if err != nil {
		internalError(w, err)
		return
	}
	for i := range items {
		items[i] = s.withDownloadURL(items[i])
		if isAdministrator(session.User.Role) {
			items[i] = s.withStoragePath(items[i])
		}
	}
	body := map[string]any{"items": items, "total": total, "page": page, "pageSize": size, "releaseUploadEnabled": s.StorageAvailable()}
	if isAdministrator(session.User.Role) {
		body["releaseStorage"] = s.releaseStorageInfo()
	}
	jsonResponse(w, 200, body)
}

// upload 以流方式保存DMG/APK草稿。参数：multipart包含platform、arch、version、buildNumber、notes、file，顺序任意；返回值：完整草稿元数据；注意事项：不将安装包读入内存，异常清理临时文件，文件落盘后才提交数据库。
func (s *Server) upload(w http.ResponseWriter, r *http.Request) {
	session, ok := s.authenticate(w, r, true)
	if !ok {
		return
	}
	if !s.StorageAvailable() {
		apiError(w, 503, "RELEASE_STORAGE_DISABLED", "安装包共享目录或卷标识不可用")
		return
	}
	if !s.hub.AllowAttempt(r.Context(), "admin:upload:"+session.User.ID, 20, time.Hour) {
		apiError(w, 429, "RATE_LIMITED", "上传过于频繁，请稍后再试")
		return
	}
	logx.Infof("------------- 上传客户端安装包 --------------")
	r.Body = http.MaxBytesReader(w, r.Body, s.cfg.MaxUploadBytes+65536)
	reader, err := r.MultipartReader()
	if err != nil {
		apiError(w, 400, "INVALID", "请使用multipart上传安装包")
		return
	}
	file, err := os.CreateTemp(s.cfg.ReleaseDir, ".upload-*")
	if err != nil {
		internalError(w, err)
		return
	}
	temp := file.Name()
	defer os.Remove(temp)
	defer file.Close()
	fields := map[string]string{}
	fileName := ""
	var size int64
	hash := sha256.New()
	parts := 0
	for {
		part, e := reader.NextPart()
		if e == io.EOF {
			break
		}
		if e != nil {
			apiError(w, 413, "UPLOAD_FAILED", "上传中断或文件超过大小限制")
			return
		}
		parts++
		if parts > 8 {
			part.Close()
			apiError(w, 400, "INVALID", "上传字段过多")
			return
		}
		if part.FormName() == "file" && part.FileName() != "" {
			if fileName != "" {
				part.Close()
				apiError(w, 400, "INVALID", "一次只能上传一个安装包")
				return
			}
			fileName = filepath.Base(part.FileName())
			size, err = io.Copy(io.MultiWriter(file, hash), io.LimitReader(part, s.cfg.MaxUploadBytes+1))
			part.Close()
			if err != nil || size > s.cfg.MaxUploadBytes {
				apiError(w, 413, "FILE_TOO_LARGE", "安装包上传失败或超过大小限制")
				return
			}
		} else {
			key := part.FormName()
			if key != "platform" && key != "arch" && key != "version" && key != "buildNumber" && key != "notes" {
				part.Close()
				apiError(w, 400, "INVALID", "包含未知上传字段")
				return
			}
			if _, exists := fields[key]; exists {
				part.Close()
				apiError(w, 400, "INVALID", "上传字段不能重复")
				return
			}
			value, e := io.ReadAll(io.LimitReader(part, 8193))
			part.Close()
			if e != nil || len(value) > 8192 {
				apiError(w, 400, "INVALID", "版本说明或字段过长")
				return
			}
			fields[key] = strings.TrimSpace(string(value))
		}
	}
	build, err := strconv.ParseInt(fields["buildNumber"], 10, 64)
	platform, arch := fields["platform"], fields["arch"]
	if err != nil || build < 1 || build > 2100000000 || !validTarget(platform, arch) || (platform == "android" && arch != "universal") || !versionPattern.MatchString(fields["version"]) || size == 0 || len(fileName) > 200 || strings.ContainsAny(fileName, "\r\n") {
		apiError(w, 400, "INVALID", "请填写有效平台、架构、三段版本号、正整数构建号并选择安装包")
		return
	}
	extension := ".dmg"
	if platform == "android" {
		extension = ".apk"
	}
	if strings.ToLower(filepath.Ext(fileName)) != extension || !validPackage(file, size, platform) {
		apiError(w, 400, "INVALID_PACKAGE", "安装包扩展名或文件格式与目标平台不匹配")
		return
	}
	if err = file.Sync(); err != nil {
		internalError(w, err)
		return
	}
	if err = file.Close(); err != nil {
		internalError(w, err)
		return
	}
	id := uuid.NewString()
	storageKey := id + extension
	destination := filepath.Join(s.cfg.ReleaseDir, storageKey)
	if !s.StorageAvailable() {
		apiError(w, 503, "RELEASE_STORAGE_DISABLED", "上传期间共享卷不可用，请恢复挂载后重试")
		return
	}
	if err = os.Rename(temp, destination); err != nil {
		internalError(w, err)
		return
	}
	item := storage.Release{ID: id, Platform: platform, Arch: arch, Version: fields["version"], BuildNumber: build, Notes: fields["notes"], FileName: fileName, Size: size, SHA256: hex.EncodeToString(hash.Sum(nil)), StorageKey: storageKey, Status: "draft", CreatedBy: session.User.Email, CreatedAt: time.Now().UTC()}
	if err = s.store.SaveRelease(r.Context(), item); err != nil {
		os.Remove(destination)
		if errors.Is(err, storage.ErrAccountExists) {
			apiError(w, 409, "BUILD_EXISTS", "该平台和架构的构建号已存在，请使用新的构建号")
			return
		}
		internalError(w, err)
		return
	}
	logx.Infof("安装包草稿保存完成 actor=" + session.User.ID + " release=" + id + " platform=" + platform + " arch=" + arch + " size=" + strconv.FormatInt(size, 10))
	// ------------ 复制到其他节点，避免下载被负载均衡到没有文件的机器 ---------------
	copied := s.replicatePackage(r.Context(), destination, storageKey, item.SHA256, size)
	jsonResponse(w, 201, s.releaseResult(item, copied))
}

// validPackage 校验安装容器最小格式。参数：file 为上传临时文件，size为字节数；返回值：是否符合DMG或ZIP容器头；注意事项：Android包名及签名由原生安装前再次验证，DMG需UDIF尾部标记。
func validPackage(file *os.File, size int64, platform string) bool {
	header := make([]byte, 4)
	offset := int64(0)
	expected := "PK\x03\x04"
	if platform == "mac" {
		if size < 512 {
			return false
		}
		offset = size - 512
		expected = "koly"
	}
	_, err := file.ReadAt(header, offset)
	return err == nil && string(header) == expected
}

// publish 显式发布已上传草稿。参数：id为版本ID；返回值：已发布记录；注意事项：发布前再次确认共享目录内安装包存在且大小和SHA256一致。
func (s *Server) publish(w http.ResponseWriter, r *http.Request) {
	session, ok := s.authenticate(w, r, true)
	if !ok {
		return
	}
	item, err := s.store.FindRelease(r.Context(), r.PathValue("id"))
	if errors.Is(err, storage.ErrNotFound) {
		apiError(w, 404, "NOT_FOUND", "版本不存在")
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	path, ok := s.releasePath(item)
	if !ok {
		apiError(w, 503, "RELEASE_STORAGE_DISABLED", "安装包存储不可用")
		return
	}
	if !s.packageReady(r.Context(), path, item) {
		apiError(w, 409, "PACKAGE_MISSING", "安装包缺失或大小不符，请检查共享存储")
		return
	}
	file, err := os.Open(path)
	if err != nil {
		internalError(w, err)
		return
	}
	hash := sha256.New()
	_, err = io.Copy(hash, file)
	file.Close()
	if err != nil {
		internalError(w, err)
		return
	}
	if hex.EncodeToString(hash.Sum(nil)) != item.SHA256 {
		apiError(w, 409, "PACKAGE_CORRUPTED", "安装包校验失败，请重新上传新的构建版本")
		return
	}
	s.changeStatus(w, r, item.ID, "published", session.User.ID)
}

// withdraw 撤回版本停止新下载。参数：id为版本ID；返回值：撤回记录；注意事项：已下载到用户设备的文件无法远程撤销。
func (s *Server) withdraw(w http.ResponseWriter, r *http.Request) {
	session, ok := s.authenticate(w, r, true)
	if !ok {
		return
	}
	s.changeStatus(w, r, r.PathValue("id"), "withdrawn", session.User.ID)
}

// changeStatus 记录发布审计并变更元数据。参数：id/status/actor为目标、状态和操作账号；返回值：版本JSON；注意事项：不删除历史安装包。
func (s *Server) changeStatus(w http.ResponseWriter, r *http.Request, id, status, actor string) {
	item, err := s.store.SetReleaseStatus(r.Context(), id, status)
	if errors.Is(err, storage.ErrNotFound) {
		apiError(w, 404, "NOT_FOUND", "版本不存在")
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	logx.Infof("版本状态变更 actor=" + actor + " release=" + id + " status=" + status)
	jsonResponse(w, 200, map[string]any{"release": s.withDownloadURL(item)})
}

// compareVersion 比较三段稳定版号。参数：a/b为已校验的版本；返回值：-1、0、1；注意事项：不支持预发布版和自动降级。
func compareVersion(a, b string) int {
	left, right := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < 3; i++ {
		x, _ := strconv.ParseInt(left[i], 10, 64)
		y, _ := strconv.ParseInt(right[i], 10, 64)
		if x < y {
			return -1
		}
		if x > y {
			return 1
		}
	}
	return 0
}

// latest 返回兼容且比当前版本更新的发布包。参数：platform、arch、currentVersion、currentBuild；返回值：release或null；注意事项：Android以构建号防降级，mac仅以语义版号比较，草稿与撤回永不返回。
func (s *Server) latest(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	platform, arch := query.Get("platform"), query.Get("arch")
	version := query.Get("currentVersion")
	if version == "" {
		version = query.Get("version")
	}
	buildText := query.Get("currentBuild")
	if buildText == "" {
		buildText = query.Get("buildNumber")
	}
	build, err := strconv.ParseInt(buildText, 10, 64)
	if !validTarget(platform, arch) || !versionPattern.MatchString(version) || err != nil || build < 0 || build > 2100000000 {
		apiError(w, 400, "INVALID", "版本检查参数不正确")
		return
	}
	items, err := s.store.LatestReleases(r.Context(), platform, arch)
	if err != nil {
		internalError(w, err)
		return
	}
	var selected *storage.Release
	for _, item := range items {
		comparison := compareVersion(item.Version, version)
		newer := comparison > 0
		if platform == "android" {
			newer = item.BuildNumber > build && comparison >= 0
		}
		if !newer {
			continue
		}
		if selected == nil || compareVersion(item.Version, selected.Version) > 0 || (item.Version == selected.Version && (item.BuildNumber > selected.BuildNumber || (item.BuildNumber == selected.BuildNumber && item.Arch == arch))) {
			copy := s.withDownloadURL(item)
			selected = &copy
		}
	}
	var manifest any
	if selected != nil {
		manifest = map[string]any{"id": selected.ID, "platform": selected.Platform, "arch": selected.Arch, "version": selected.Version, "buildNumber": selected.BuildNumber, "notes": selected.Notes, "fileName": selected.FileName, "size": selected.Size, "sha256": selected.SHA256, "downloadUrl": selected.DownloadURL, "publishedAt": selected.PublishedAt}
	}
	jsonResponse(w, 200, map[string]any{"release": manifest})
}

// releasePath 解析服务器生成的安装包名。参数：item为元数据；返回值：受控路径和有效标记；注意事项：禁止路径穿越，数据库不保存客户端提供的路径。
func (s *Server) releasePath(item storage.Release) (string, bool) {
	if !s.StorageAvailable() || item.StorageKey == "" || filepath.Base(item.StorageKey) != item.StorageKey {
		return "", false
	}
	return filepath.Join(s.cfg.ReleaseDir, item.StorageKey), true
}

// download 提供公开安装包及Range续传。参数：id为已发布记录；返回值：二进制文件；注意事项：只读普通文件，HEAD不计数，客户端必须验证SHA256和大小。
func (s *Server) download(w http.ResponseWriter, r *http.Request) {
	item, err := s.store.FindRelease(r.Context(), r.PathValue("id"))
	if errors.Is(err, storage.ErrNotFound) || (err == nil && item.Status != "published") {
		apiError(w, 404, "NOT_FOUND", "版本不存在或已撤回")
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	path, ok := s.releasePath(item)
	if !ok {
		apiError(w, 503, "PACKAGE_UNAVAILABLE", "安装包存储尚未配置")
		return
	}
	if !s.packageReady(r.Context(), path, item) {
		apiError(w, 503, "PACKAGE_UNAVAILABLE", "安装包暂不可用，请稍后再试")
		return
	}
	file, err := os.Open(path)
	if err != nil {
		apiError(w, 503, "PACKAGE_UNAVAILABLE", "安装包暂不可用，请稍后再试")
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() != item.Size {
		apiError(w, 503, "PACKAGE_UNAVAILABLE", "安装包暂不可用，请联系管理员")
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": item.FileName}))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("ETag", fmt.Sprintf("\"%s\"", item.SHA256))
	w.Header().Set("X-Checksum-SHA256", item.SHA256)
	if r.Method == "GET" {
		if err = s.store.CountDownload(r.Context(), item.ID); err != nil {
			logx.Warnf("下载计数失败 release=" + item.ID)
		}
	}
	http.ServeContent(w, r, item.FileName, info.ModTime(), file)
}

// StorageAvailable 动态检查共享卷身份。参数：无，读取已配置目录和标识；返回值：目录可访问且卷标识一致时为true；注意事项：应用绝不创建标识文件，挂载丢失的本地空目录不能继续接收安装包。
func (s *Server) StorageAvailable() bool {
	if s.cfg.ReleaseDir == "" {
		return false
	}
	info, err := os.Stat(s.cfg.ReleaseDir)
	if err != nil || !info.IsDir() {
		return false
	}
	if s.cfg.StorageID == "" {
		return true
	}
	marker, err := os.Open(filepath.Join(s.cfg.ReleaseDir, ".relay-storage-id"))
	if err != nil {
		return false
	}
	defer marker.Close()
	value, err := io.ReadAll(io.LimitReader(marker, 257))
	return err == nil && len(value) <= 256 && strings.TrimSpace(string(value)) == s.cfg.StorageID
}
