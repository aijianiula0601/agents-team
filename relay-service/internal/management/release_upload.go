package management

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"agents-team-relay/internal/logx"
	"agents-team-relay/internal/realtime"
	"agents-team-relay/internal/storage"

	"github.com/google/uuid"
)

// uploadChunkBytes 是单段上传大小。入口负载均衡大约拒绝 60MB 以上的单次请求，16MB 可以稳定通过，也便于中途中断。
var uploadChunkBytes int64 = 16 << 20

var manualNamePattern = regexp.MustCompile(`(?i)^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.(dmg|apk)$`)

// uploadMeta 是创建分段上传或登记已有文件时的版本信息。
//
// 参数：字段来自管理页。
// 返回值：供会话和入库使用。
// 注意事项：FileName 是用户看到的安装包名，不是服务器上的最终文件名。
type uploadMeta struct {
	Platform    string `json:"platform"`
	Arch        string `json:"arch"`
	Version     string `json:"version"`
	Notes       string `json:"notes"`
	FileName    string `json:"fileName"`
	BuildNumber int64  `json:"buildNumber"`
	Size        int64  `json:"size"`
}

// uploadSession 记录一段尚未登记的上传。
//
// 参数：ID 同时作为最终安装包文件名的主体。
// 返回值：保存在 Redis，所有节点都能读到进度。
// 注意事项：文件本体只写在写入节点，其他节点把请求转过去。
type uploadSession struct {
	uploadMeta
	ID       string `json:"id"`
	Received int64  `json:"received"`
	Actor    string `json:"actor"`
}

// writesLocally 判断当前节点是否负责保存上传中的安装包。
//
// 参数：r 为当前请求，用于识别已经从其他节点转发过来的内部请求。
// 返回值：应在本机写入时为 true。
// 注意事项：未配置写入节点时每台机器各自写入；配置后只有写入节点落盘，避免分段被负载均衡拆到两台磁盘。
func (s *Server) writesLocally(r *http.Request) bool {
	if r != nil && s.forwardedUpload(r) {
		return true
	}
	if s.cfg.WriterURL == "" {
		return true
	}
	return s.cfg.SelfURL != "" && s.cfg.SelfURL == s.cfg.WriterURL
}

// forwardedUpload 校验内部转发标记。
//
// 参数：r 为收到的请求。
// 返回值：标记由持有同步密钥的节点签发时为 true。
// 注意事项：浏览器无法伪造该标记，避免把分段写到错误的机器后又被再次转发。
func (s *Server) forwardedUpload(r *http.Request) bool {
	length := r.ContentLength
	if length < 0 {
		length = 0
	}
	return s.authorizedSync(r.Header.Get("X-Release-Forwarded"), "forward", r.URL.RequestURI(), length)
}

// forwardToWriter 把上传请求原样交给写入节点。
//
// 参数：body/length 为空时使用原始请求体。
// 返回值：无。写入节点的状态码和响应体会回给浏览器。
// 注意事项：必须带上 Cookie、CSRF 和 Origin，写入节点会再次鉴权。
func (s *Server) forwardToWriter(w http.ResponseWriter, r *http.Request, body io.Reader, length int64) {
	if body == nil {
		body = r.Body
		length = r.ContentLength
	}
	if length < 0 {
		length = 0
	}
	logx.Infof("------------- 转发安装包上传到写入节点 --------------")
	req, err := http.NewRequestWithContext(r.Context(), r.Method, s.cfg.WriterURL+r.URL.RequestURI(), body)
	if err != nil {
		internalError(w, err)
		return
	}
	req.ContentLength = length
	for _, header := range []string{"Cookie", "X-CSRF-Token", "Content-Type", "Origin"} {
		if value := r.Header.Get(header); value != "" {
			req.Header.Set(header, value)
		}
	}
	req.Header.Set("X-Release-Forwarded", releaseSyncMAC(s.cfg.SyncKey, "forward", r.URL.RequestURI(), length))
	resp, err := peerClient.Do(req)
	if err != nil {
		logx.Warnf("转发安装包上传失败 err=%v", err)
		apiError(w, 503, "UPLOAD_PEER_UNAVAILABLE", "安装包写入节点暂时不可达，请稍后重试")
		return
	}
	defer resp.Body.Close()
	for _, header := range []string{"Content-Type", "Cache-Control", "X-Content-Type-Options"} {
		if value := resp.Header.Get(header); value != "" {
			w.Header().Set(header, value)
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, io.LimitReader(resp.Body, 1<<20))
}

// releaseStorageInfo 提供管理页展示的目录和分段大小。
//
// 参数：无。
// 返回值：目录、节点和单段字节数。
// 注意事项：目录是宿主机路径；容器内路径不展示给管理员。
func (s *Server) releaseStorageInfo() map[string]any {
	return map[string]any{"directory": s.cfg.HostDir, "nodes": s.cfg.Nodes, "chunkBytes": uploadChunkBytes}
}

// withStoragePath 填写宿主机上的安装包路径。
//
// 参数：item 为版本记录。
// 返回值：带 storagePath 的副本。
// 注意事项：未配置宿主机目录时留空，不把容器内路径冒充成部署目录。
func (s *Server) withStoragePath(item storage.Release) storage.Release {
	if s.cfg.HostDir == "" || item.StorageKey == "" {
		return item
	}
	item.StoragePath = s.cfg.HostDir + "/" + item.StorageKey
	return item
}

// packageLocations 列出已经确认写好的服务器路径。
//
// 参数：storageKey 为最终文件名，copied 为同步成功的节点。
// 返回值：主机和绝对路径。
// 注意事项：同步失败的节点不列入，页面只展示实际写入的位置。
func (s *Server) packageLocations(storageKey string, copied []string) []map[string]string {
	if s.cfg.HostDir == "" || storageKey == "" {
		return nil
	}
	path := s.cfg.HostDir + "/" + storageKey
	seen := map[string]struct{}{}
	var hosts []string
	add := func(host string) {
		if host == "" {
			return
		}
		if _, ok := seen[host]; ok {
			return
		}
		seen[host] = struct{}{}
		hosts = append(hosts, host)
	}
	add(peerHost(s.cfg.SelfURL))
	for _, peer := range copied {
		add(peerHost(peer))
	}
	out := make([]map[string]string, 0, len(hosts))
	for _, host := range hosts {
		out = append(out, map[string]string{"host": host, "path": path})
	}
	return out
}

// releaseResult 组装上传成功响应。
//
// 参数：item 为草稿，copied 为已同步节点。
// 返回值：版本和实际路径。
// 注意事项：下载地址仍是站点相对路径。
func (s *Server) releaseResult(item storage.Release, copied []string) map[string]any {
	item = s.withDownloadURL(s.withStoragePath(item))
	return map[string]any{"release": item, "locations": s.packageLocations(item.StorageKey, copied)}
}

// validateUploadMeta 检查版本字段和文件大小。
//
// 参数：meta 为上传说明，manual 表示文件名必须能直接作为目录中的文件名。
// 返回值：可直接展示的错误文字；通过时为空。
// 注意事项：手动登记拒绝隐藏文件和路径分隔符。
func validateUploadMeta(meta uploadMeta, manual bool) string {
	extension := ".dmg"
	if meta.Platform == "android" {
		extension = ".apk"
	}
	name := strings.TrimSpace(meta.FileName)
	if meta.BuildNumber < 1 || meta.BuildNumber > 2100000000 || !validTarget(meta.Platform, meta.Arch) || (meta.Platform == "android" && meta.Arch != "universal") || !versionPattern.MatchString(meta.Version) || meta.Size < 1 || len(name) > 200 || strings.ContainsAny(name, "\r\n") || len(meta.Notes) > 8192 {
		return "请填写有效平台、架构、三段版本号、正整数构建号和安装包"
	}
	if !strings.EqualFold(filepath.Ext(name), extension) {
		return "安装包扩展名与目标平台不匹配"
	}
	if manual && (!manualNamePattern.MatchString(name) || !strings.EqualFold(filepath.Ext(name), extension)) {
		return "手动上传的文件名只能包含字母、数字、点、下划线和短横线，并以 .dmg 或 .apk 结尾"
	}
	return ""
}

// saveUploadSession 保存上传进度。
//
// 参数：session 为当前进度。
// 返回值：Redis 写入错误。
// 注意事项：6 小时后自动过期，半成品文件由清理逻辑删除。
func (s *Server) saveUploadSession(ctx context.Context, session uploadSession) error {
	raw, err := json.Marshal(session)
	if err != nil {
		return err
	}
	return s.hub.PutTransient(ctx, "release-upload:"+session.ID, string(raw), 6*time.Hour)
}

// loadUploadSession 读取上传进度。
//
// 参数：id 为上传标识。
// 返回值：会话；不存在时返回 ErrNotFound。
// 注意事项：调用方还要核对操作者。
func (s *Server) loadUploadSession(ctx context.Context, id string) (uploadSession, error) {
	var session uploadSession
	raw, err := s.hub.GetTransient(ctx, "release-upload:"+id)
	if realtime.IsTransientMissing(err) {
		return session, storage.ErrNotFound
	}
	if err != nil {
		return session, err
	}
	if json.Unmarshal([]byte(raw), &session) != nil || session.ID != id {
		return session, storage.ErrNotFound
	}
	return session, nil
}

// dropUploadSession 删除上传进度。参数：id 为上传标识；返回值：无；注意事项：会话已过期时也视为删除成功。
func (s *Server) dropUploadSession(ctx context.Context, id string) {
	_, _ = s.hub.TakeTransient(ctx, "release-upload:"+id)
}

// partPath 返回分段临时文件路径。参数：id 为上传标识；返回值：受控路径；注意事项：调用前必须确认 id 是 UUID。
func (s *Server) partPath(id string) string {
	return filepath.Join(s.cfg.ReleaseDir, ".part-"+id)
}

// sweepPartialUploads 删除过期的半成品。
//
// 参数：无。
// 返回值：无。
// 注意事项：只删除 6 小时前的 .part- 文件，不触碰已登记的安装包。
func (s *Server) sweepPartialUploads() {
	entries, err := os.ReadDir(s.cfg.ReleaseDir)
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-6 * time.Hour)
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), ".part-") {
			continue
		}
		info, statErr := entry.Info()
		if statErr != nil || info.ModTime().After(cutoff) {
			continue
		}
		_ = os.Remove(filepath.Join(s.cfg.ReleaseDir, entry.Name()))
	}
}

// createUpload 开始一次可中断的分段上传。
//
// 参数：JSON 包含平台、架构、版本、构建号、说明、原始文件名和总字节数。
// 返回值：上传标识和单段大小。
// 注意事项：文件先放在写入节点的临时名下，完成校验后才登记为草稿。
func (s *Server) createUpload(w http.ResponseWriter, r *http.Request) {
	sessionUser, ok := s.authenticate(w, r, true)
	if !ok {
		return
	}
	if !s.StorageAvailable() {
		apiError(w, 503, "RELEASE_STORAGE_DISABLED", "安装包目录不可用")
		return
	}
	if !s.writesLocally(r) {
		s.forwardToWriter(w, r, nil, 0)
		return
	}
	if !s.hub.AllowAttempt(r.Context(), "admin:upload:"+sessionUser.User.ID, 20, time.Hour) {
		apiError(w, 429, "RATE_LIMITED", "上传过于频繁，请稍后再试")
		return
	}
	var meta uploadMeta
	if !decode(w, r, &meta) {
		return
	}
	meta.FileName = strings.TrimSpace(meta.FileName)
	meta.Notes = strings.TrimSpace(meta.Notes)
	if meta.Size > s.cfg.MaxUploadBytes {
		apiError(w, 413, "FILE_TOO_LARGE", "安装包超过大小限制")
		return
	}
	if message := validateUploadMeta(meta, false); message != "" {
		apiError(w, 400, "INVALID", message)
		return
	}
	s.sweepPartialUploads()
	id := uuid.NewString()
	file, err := os.OpenFile(s.partPath(id), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		internalError(w, err)
		return
	}
	_ = file.Close()
	record := uploadSession{uploadMeta: meta, ID: id, Actor: sessionUser.User.ID}
	if err = s.saveUploadSession(r.Context(), record); err != nil {
		_ = os.Remove(s.partPath(id))
		internalError(w, err)
		return
	}
	logx.Infof("------------- 开始分段上传 -------------- id=%s platform=%s size=%d", id, meta.Platform, meta.Size)
	jsonResponse(w, 201, map[string]any{"id": id, "chunkBytes": uploadChunkBytes, "releaseStorage": s.releaseStorageInfo()})
}

// writeUploadChunk 写入下一段安装包。
//
// 参数：id 为上传标识，offset 查询参数是已确认写入的字节位置，正文是原始分段。
// 返回值：已接收字节数。
// 注意事项：同一段因网络重试再次提交时直接确认，不会把内容写两遍。
func (s *Server) writeUploadChunk(w http.ResponseWriter, r *http.Request) {
	sessionUser, ok := s.authenticate(w, r, true)
	if !ok {
		return
	}
	if !s.StorageAvailable() {
		apiError(w, 503, "RELEASE_STORAGE_DISABLED", "安装包目录不可用")
		return
	}
	if !s.writesLocally(r) {
		s.forwardToWriter(w, r, nil, 0)
		return
	}
	id := r.PathValue("id")
	record, err := s.loadOwnedUpload(r.Context(), id, sessionUser.User.ID)
	if err != nil {
		s.replyUploadLookup(w, err)
		return
	}
	offset, err := strconv.ParseInt(r.URL.Query().Get("offset"), 10, 64)
	length := r.ContentLength
	if err != nil || offset < 0 || length <= 0 || length > uploadChunkBytes || offset > record.Received || offset+length > record.Size {
		apiError(w, 400, "INVALID_CHUNK", "上传分段位置或大小不正确")
		return
	}
	if offset < record.Received {
		_, _ = io.Copy(io.Discard, io.LimitReader(r.Body, length))
		jsonResponse(w, 200, map[string]any{"received": record.Received, "size": record.Size})
		return
	}
	file, err := os.OpenFile(s.partPath(id), os.O_WRONLY, 0600)
	if err != nil {
		internalError(w, err)
		return
	}
	defer file.Close()
	if _, err = file.Seek(offset, io.SeekStart); err != nil {
		internalError(w, err)
		return
	}
	written, err := io.Copy(file, io.LimitReader(r.Body, length))
	if err != nil || written != length {
		_ = file.Truncate(offset)
		apiError(w, 400, "UPLOAD_INTERRUPTED", "上传已中断，请从当前进度重试或取消")
		return
	}
	record.Received += written
	if err = s.saveUploadSession(r.Context(), record); err != nil {
		internalError(w, err)
		return
	}
	jsonResponse(w, 200, map[string]any{"received": record.Received, "size": record.Size})
}

// finishUpload 校验完整安装包并登记草稿。
//
// 参数：id 为上传标识。
// 返回值：草稿和实际存放路径。
// 注意事项：字节没收齐、格式不对或哈希失败时删除临时文件。
func (s *Server) finishUpload(w http.ResponseWriter, r *http.Request) {
	sessionUser, ok := s.authenticate(w, r, true)
	if !ok {
		return
	}
	if !s.StorageAvailable() {
		apiError(w, 503, "RELEASE_STORAGE_DISABLED", "安装包目录不可用")
		return
	}
	if !s.writesLocally(r) {
		s.forwardToWriter(w, r, nil, 0)
		return
	}
	record, err := s.loadOwnedUpload(r.Context(), r.PathValue("id"), sessionUser.User.ID)
	if err != nil {
		s.replyUploadLookup(w, err)
		return
	}
	if record.Received != record.Size {
		apiError(w, 409, "UPLOAD_INCOMPLETE", "安装包尚未上传完整")
		return
	}
	logx.Infof("------------- 完成分段上传 -------------- id=%s", record.ID)
	item, copied, err := s.commitPackage(r.Context(), sessionUser.User.Email, record.uploadMeta, s.partPath(record.ID), record.ID)
	s.dropUploadSession(r.Context(), record.ID)
	if err != nil {
		_ = os.Remove(s.partPath(record.ID))
		s.replyCommit(w, err)
		return
	}
	jsonResponse(w, 201, s.releaseResult(item, copied))
}

// cancelUpload 中断上传并删除半成品。
//
// 参数：id 为上传标识。
// 返回值：204。
// 注意事项：重复取消也返回成功，方便浏览器在断开后重试清理。
func (s *Server) cancelUpload(w http.ResponseWriter, r *http.Request) {
	sessionUser, ok := s.authenticate(w, r, true)
	if !ok {
		return
	}
	if !s.writesLocally(r) {
		s.forwardToWriter(w, r, nil, 0)
		return
	}
	id := r.PathValue("id")
	if _, err := uuid.Parse(id); err != nil {
		apiError(w, 404, "NOT_FOUND", "上传不存在")
		return
	}
	record, err := s.loadUploadSession(r.Context(), id)
	if err == nil && record.Actor != sessionUser.User.ID {
		apiError(w, 404, "NOT_FOUND", "上传不存在")
		return
	}
	if err != nil && !errors.Is(err, storage.ErrNotFound) {
		internalError(w, err)
		return
	}
	_ = os.Remove(s.partPath(id))
	s.dropUploadSession(r.Context(), id)
	logx.Infof("分段上传已中断 id=%s", id)
	w.WriteHeader(http.StatusNoContent)
}

// importRelease 登记已经放到安装包目录里的文件。
//
// 参数：JSON 包含版本信息和服务器上的文件名。
// 返回值：草稿和改名后的实际路径。
// 注意事项：文件名不能带目录。登记成功后原文件名会被换成服务生成的名字。
func (s *Server) importRelease(w http.ResponseWriter, r *http.Request) {
	sessionUser, ok := s.authenticate(w, r, true)
	if !ok {
		return
	}
	if !s.StorageAvailable() {
		apiError(w, 503, "RELEASE_STORAGE_DISABLED", "安装包目录不可用")
		return
	}
	var meta uploadMeta
	if !decode(w, r, &meta) {
		return
	}
	meta.FileName = strings.TrimSpace(meta.FileName)
	meta.Notes = strings.TrimSpace(meta.Notes)
	if !manualNamePattern.MatchString(meta.FileName) {
		apiError(w, 400, "INVALID", "手动上传的文件名只能包含字母、数字、点、下划线和短横线，并以 .dmg 或 .apk 结尾")
		return
	}
	source := filepath.Join(s.cfg.ReleaseDir, meta.FileName)
	info, statErr := os.Stat(source)
	if statErr != nil || !info.Mode().IsRegular() {
		if !s.writesLocally(r) {
			payload, err := json.Marshal(meta)
			if err != nil {
				internalError(w, err)
				return
			}
			s.forwardToWriter(w, r, bytes.NewReader(payload), int64(len(payload)))
			return
		}
		apiError(w, 404, "PACKAGE_NOT_FOUND", "目录中没有这个文件。请把安装包复制到每台服务器的安装包目录，并保持文件名不变")
		return
	}
	meta.Size = info.Size()
	if meta.Size > s.cfg.MaxUploadBytes {
		apiError(w, 413, "FILE_TOO_LARGE", "安装包超过大小限制")
		return
	}
	if message := validateUploadMeta(meta, true); message != "" {
		apiError(w, 400, "INVALID", message)
		return
	}
	if !s.hub.AllowAttempt(r.Context(), "admin:upload:"+sessionUser.User.ID, 20, time.Hour) {
		apiError(w, 429, "RATE_LIMITED", "上传过于频繁，请稍后再试")
		return
	}
	logx.Infof("------------- 登记手动上传的安装包 -------------- name=%s", meta.FileName)
	item, copied, err := s.commitPackage(r.Context(), sessionUser.User.Email, meta, source, uuid.NewString())
	if err != nil {
		s.replyCommit(w, err)
		return
	}
	jsonResponse(w, 201, s.releaseResult(item, copied))
}

// loadOwnedUpload 读取并核对上传属于当前管理员。
//
// 参数：id/actor 为上传标识和操作者。
// 返回值：会话或错误。
// 注意事项：别人的上传标识一律表现为不存在。
func (s *Server) loadOwnedUpload(ctx context.Context, id, actor string) (uploadSession, error) {
	if _, err := uuid.Parse(id); err != nil {
		return uploadSession{}, storage.ErrNotFound
	}
	record, err := s.loadUploadSession(ctx, id)
	if err != nil {
		return record, err
	}
	if record.Actor != actor {
		return uploadSession{}, storage.ErrNotFound
	}
	return record, nil
}

// replyUploadLookup 把上传查询错误写成响应。参数：err 为查询结果；返回值：无；注意事项：不区分过期和不存在。
func (s *Server) replyUploadLookup(w http.ResponseWriter, err error) {
	if errors.Is(err, storage.ErrNotFound) {
		apiError(w, 404, "NOT_FOUND", "上传不存在或已结束")
		return
	}
	internalError(w, err)
}

// commitPackage 校验安装包、改成服务文件名并写入版本草稿。
//
// 参数：actor 为操作者，meta 为版本信息，source 为待登记文件，id 为最终文件名主体。
// 返回值：草稿、同步成功的节点和错误。
// 注意事项：格式或入库失败时保留手动上传的原文件，分段上传的临时文件由调用方删除。
func (s *Server) commitPackage(ctx context.Context, actor string, meta uploadMeta, source, id string) (storage.Release, []string, error) {
	var none storage.Release
	file, err := os.Open(source)
	if err != nil {
		return none, nil, err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() != meta.Size || !validPackage(file, info.Size(), meta.Platform) {
		file.Close()
		return none, nil, errInvalidPackage
	}
	sum, err := hashFile(file)
	file.Close()
	if err != nil {
		return none, nil, err
	}
	extension := ".dmg"
	if meta.Platform == "android" {
		extension = ".apk"
	}
	storageKey := id + extension
	destination := filepath.Join(s.cfg.ReleaseDir, storageKey)
	if err = os.Rename(source, destination); err != nil {
		return none, nil, err
	}
	item := storage.Release{ID: id, Platform: meta.Platform, Arch: meta.Arch, Version: meta.Version, BuildNumber: meta.BuildNumber, Notes: meta.Notes, FileName: meta.FileName, Size: meta.Size, SHA256: sum, StorageKey: storageKey, Status: "draft", CreatedBy: actor, CreatedAt: time.Now().UTC()}
	if err = s.store.SaveRelease(ctx, item); err != nil {
		_ = os.Rename(destination, source)
		return none, nil, err
	}
	logx.Infof("安装包草稿保存完成 actor=%s release=%s platform=%s size=%d", actor, id, meta.Platform, meta.Size)
	return item, s.replicatePackage(ctx, destination, storageKey, item.SHA256, item.Size), nil
}

var errInvalidPackage = errors.New("invalid package")

// hashFile 计算文件 SHA256。参数：file 为已打开文件；返回值：十六进制摘要；注意事项：计算前会回到文件开头。
func hashFile(file *os.File) (string, error) {
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	sum := sha256.New()
	if _, err := io.Copy(sum, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(sum.Sum(nil)), nil
}

// replyCommit 把登记失败写成可理解的错误。参数：err 为登记错误；返回值：无；注意事项：格式错误不暴露文件系统细节。
func (s *Server) replyCommit(w http.ResponseWriter, err error) {
	if errors.Is(err, errInvalidPackage) {
		apiError(w, 400, "INVALID_PACKAGE", "安装包扩展名或文件格式与目标平台不匹配")
		return
	}
	if errors.Is(err, storage.ErrAccountExists) {
		apiError(w, 409, "BUILD_EXISTS", "该平台和架构的构建号已存在，请使用新的构建号")
		return
	}
	internalError(w, err)
}
