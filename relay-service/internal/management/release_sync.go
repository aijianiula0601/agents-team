package management

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"time"

	"agents-team-relay/internal/logx"
	"agents-team-relay/internal/storage"
)

var storageKeyPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(dmg|apk)$`)

// peerClient 在测试机之间复制安装包。参数：无；返回值：禁止跳转和代理的客户端；注意事项：连接失败在 5 秒内返回，已连通的大文件仍可传输最多 3 分钟。
var peerClient = &http.Client{
	Timeout: 3 * time.Minute,
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	},
	Transport: &http.Transport{
		Proxy:                 nil,
		DialContext:           (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		ResponseHeaderTimeout: 30 * time.Second,
		IdleConnTimeout:       30 * time.Second,
		TLSHandshakeTimeout:   5 * time.Second,
	},
}

// SyncKeyFromToken 从服务令牌密钥派生安装包同步密钥。
//
// 参数：tokenKey 为进程令牌密钥。
// 返回值：仅用于节点间安装包校验的独立密钥；空输入返回 nil。
// 注意事项：不复用令牌原文，避免同步请求和登录令牌共用同一 HMAC 输入空间。
func SyncKeyFromToken(tokenKey []byte) []byte {
	if len(tokenKey) == 0 {
		return nil
	}
	mac := hmac.New(sha256.New, tokenKey)
	_, _ = mac.Write([]byte("agents-team-release-sync"))
	return mac.Sum(nil)
}

// releaseSyncMAC 计算安装包同步签名。
//
// 参数：key 为派生密钥，storageKey/sum/size 为文件身份。
// 返回值：十六进制 HMAC。
// 注意事项：签名覆盖文件名、哈希和长度，不能只凭密钥访问其他文件。
func releaseSyncMAC(key []byte, storageKey, sum string, size int64) string {
	mac := hmac.New(sha256.New, key)
	_, _ = fmt.Fprintf(mac, "release-sync-v1\n%s\n%s\n%d", storageKey, sum, size)
	return hex.EncodeToString(mac.Sum(nil))
}

// authorizedSync 校验节点间签名。
//
// 参数：got 为请求头签名，其余为声称的文件身份。
// 返回值：签名有效时为 true。
// 注意事项：密钥为空或签名长度不同都拒绝，比较使用常量时间。
func (s *Server) authorizedSync(got, storageKey, sum string, size int64) bool {
	if len(s.cfg.SyncKey) == 0 || got == "" {
		return false
	}
	expected := releaseSyncMAC(s.cfg.SyncKey, storageKey, sum, size)
	return hmac.Equal([]byte(got), []byte(expected))
}

// remotePeers 返回需要同步的其他节点。
//
// 参数：无，读取已配置源站和本机地址。
// 返回值：去掉本机后的源站列表。
// 注意事项：未显式配置本机地址时，跳过落在本机网卡上的地址，避免把文件再写回自己。
func (s *Server) remotePeers() []string {
	local := map[string]struct{}{}
	if s.cfg.SelfURL == "" {
		addrs, err := net.InterfaceAddrs()
		if err == nil {
			for _, addr := range addrs {
				ip, _, parseErr := net.ParseCIDR(addr.String())
				if parseErr == nil && ip != nil {
					local[ip.String()] = struct{}{}
				}
			}
		}
	}
	peers := make([]string, 0, len(s.cfg.Peers))
	for _, peer := range s.cfg.Peers {
		if peer == "" || peer == s.cfg.SelfURL {
			continue
		}
		if s.cfg.SelfURL == "" {
			host := peerHost(peer)
			if ip := net.ParseIP(host); ip != nil {
				if _, ok := local[ip.String()]; ok {
					continue
				}
			}
		}
		peers = append(peers, peer)
	}
	return peers
}

// peerHost 取出源站主机名。参数：peer 为 scheme://host；返回值：主机名，解析失败时为空；注意事项：不包含端口。
func peerHost(peer string) string {
	rest := peer
	if i := len("https://"); len(peer) > i && peer[:i] == "https://" {
		rest = peer[i:]
	} else if i = len("http://"); len(peer) > i && peer[:i] == "http://" {
		rest = peer[i:]
	}
	if host, _, ok := splitHostPort(rest); ok {
		return host
	}
	return rest
}

// splitHostPort 分离主机和端口。参数：hostport 不含 scheme；返回值：主机、端口和是否包含端口；注意事项：兼容 IPv6 方括号。
func splitHostPort(hostport string) (string, string, bool) {
	host, port, err := net.SplitHostPort(hostport)
	if err != nil {
		return "", "", false
	}
	return host, port, true
}

// replicatePackage 把刚保存的安装包复制到其他节点。
//
// 参数：path 为本机文件，storageKey/sum/size 为文件身份。
// 返回值：复制成功的节点源站。单个节点失败只记日志。
// 注意事项：上传已经落盘并入库后调用；对端暂时不可达时，下载和发布会再拉取一次。
func (s *Server) replicatePackage(ctx context.Context, path, storageKey, sum string, size int64) []string {
	peers := s.remotePeers()
	if len(peers) == 0 || len(s.cfg.SyncKey) == 0 {
		return nil
	}
	logx.Infof("------------- 同步安装包到其他节点 --------------")
	copied := make([]string, 0, len(peers))
	for _, peer := range peers {
		if err := s.pushToPeer(ctx, peer, path, storageKey, sum, size); err != nil {
			logx.Warnf("同步安装包失败 peer=%s key=%s err=%v", peer, storageKey, err)
			continue
		}
		logx.Infof("安装包已同步 peer=%s key=%s size=%d", peer, storageKey, size)
		copied = append(copied, peer)
	}
	return copied
}

// pushToPeer 向一个节点推送安装包。
//
// 参数：peer 为源站，path 为已落盘文件。
// 返回值：对端确认保存后返回 nil。
// 注意事项：按文件流式发送，不把安装包读入内存。
func (s *Server) pushToPeer(ctx context.Context, peer, path, storageKey, sum string, size int64) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	reqCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPut, peer+s.cfg.Prefix+"/internal/release-blobs/"+storageKey, file)
	if err != nil {
		return err
	}
	req.ContentLength = size
	s.signRelease(req, storageKey, sum, size)
	resp, err := peerClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	if resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("status %d", resp.StatusCode)
	}
	return nil
}

// packageReady 确认本机安装包可用，缺失时向其他节点拉取。
//
// 参数：path 为本机目标路径，item 为数据库记录。
// 返回值：文件存在且大小一致时为 true。
// 注意事项：这里只核对大小；发布流程会继续核对 SHA256。
func (s *Server) packageReady(ctx context.Context, path string, item storage.Release) bool {
	if localPackageSize(path, item.Size) {
		return true
	}
	if err := s.pullPackage(ctx, item); err != nil {
		logx.Warnf("本机缺少安装包且对端拉取失败 release=%s err=%v", item.ID, err)
		return false
	}
	return localPackageSize(path, item.Size)
}

// localPackageSize 检查本机普通文件大小。参数：path/size 为路径和期望字节数；返回值：匹配时为 true；注意事项：不计算哈希。
func localPackageSize(path string, size int64) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Size() == size
}

// pullPackage 依次从其他节点拉取安装包。
//
// 参数：item 提供存储名、哈希和大小。
// 返回值：任一节点保存成功返回 nil。
// 注意事项：没有其他节点时返回错误，由调用方保持原来的不可用结果。
func (s *Server) pullPackage(ctx context.Context, item storage.Release) error {
	peers := s.remotePeers()
	if len(peers) == 0 || len(s.cfg.SyncKey) == 0 {
		return fmt.Errorf("no peer")
	}
	var last error
	for _, peer := range peers {
		if err := s.pullFromPeer(ctx, peer, item); err != nil {
			last = err
			logx.Warnf("拉取安装包失败 peer=%s release=%s err=%v", peer, item.ID, err)
			continue
		}
		logx.Infof("已从其他节点补齐安装包 peer=%s release=%s", peer, item.ID)
		return nil
	}
	if last == nil {
		last = fmt.Errorf("no peer")
	}
	return last
}

// pullFromPeer 从单个节点下载安装包并原子替换本机文件。
//
// 参数：peer 为源站，item 为期望的文件身份。
// 返回值：哈希和大小都一致后返回 nil。
// 注意事项：先写临时文件，校验通过才改名，失败删除临时文件。
func (s *Server) pullFromPeer(ctx context.Context, peer string, item storage.Release) error {
	reqCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, peer+s.cfg.Prefix+"/internal/release-blobs/"+item.StorageKey, nil)
	if err != nil {
		return err
	}
	s.signRelease(req, item.StorageKey, item.SHA256, item.Size)
	resp, err := peerClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("status %d", resp.StatusCode)
	}
	return s.storeVerifiedPackage(item.StorageKey, item.SHA256, item.Size, resp.Body)
}

// signRelease 写入同步请求头。参数：req 为目标请求，其余为文件身份；返回值：无；注意事项：不记录签名。
func (s *Server) signRelease(req *http.Request, storageKey, sum string, size int64) {
	req.Header.Set("X-Release-SHA256", sum)
	req.Header.Set("X-Release-Size", strconv.FormatInt(size, 10))
	req.Header.Set("X-Release-Sync", releaseSyncMAC(s.cfg.SyncKey, storageKey, sum, size))
}

// receivePackage 接收其他节点推送的安装包。
//
// 参数：name 为路径中的存储名。
// 返回值：校验通过后返回 204。
// 注意事项：签名错误统一表现为不存在，避免暴露目录是否启用。
func (s *Server) receivePackage(w http.ResponseWriter, r *http.Request) {
	name, sum, size, ok := s.syncRequest(r)
	if !ok || !s.StorageAvailable() {
		apiError(w, http.StatusNotFound, "NOT_FOUND", "安装包不存在")
		return
	}
	if err := s.storeVerifiedPackage(name, sum, size, io.LimitReader(r.Body, size+1)); err != nil {
		logx.Warnf("接收安装包失败 key=%s err=%v", name, err)
		apiError(w, http.StatusConflict, "PACKAGE_REJECTED", "安装包校验失败")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// serveInternalPackage 向其他节点提供已保存的安装包。
//
// 参数：name 为存储名，签名头必须与本机文件一致。
// 返回值：文件内容。
// 注意事项：只给持有正确签名的节点，不替代面向客户端的下载接口。
func (s *Server) serveInternalPackage(w http.ResponseWriter, r *http.Request) {
	name, sum, size, ok := s.syncRequest(r)
	if !ok || !s.StorageAvailable() {
		apiError(w, http.StatusNotFound, "NOT_FOUND", "安装包不存在")
		return
	}
	path := filepath.Join(s.cfg.ReleaseDir, name)
	if !packageFileMatches(path, size, sum) {
		apiError(w, http.StatusNotFound, "NOT_FOUND", "安装包不存在")
		return
	}
	file, err := os.Open(path)
	if err != nil {
		apiError(w, http.StatusNotFound, "NOT_FOUND", "安装包不存在")
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		apiError(w, http.StatusNotFound, "NOT_FOUND", "安装包不存在")
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, name, info.ModTime(), file)
}

// syncRequest 读取并校验同步身份。
//
// 参数：r 为内部同步请求。
// 返回值：存储名、哈希、大小和是否通过校验。
// 注意事项：存储名只允许服务端生成的 UUID 加 dmg/apk 后缀。
func (s *Server) syncRequest(r *http.Request) (string, string, int64, bool) {
	name := r.PathValue("name")
	sum := r.Header.Get("X-Release-SHA256")
	size, err := strconv.ParseInt(r.Header.Get("X-Release-Size"), 10, 64)
	if err != nil || !storageKeyPattern.MatchString(name) || len(sum) != 64 || size < 1 || size > s.cfg.MaxUploadBytes {
		return "", "", 0, false
	}
	if !s.authorizedSync(r.Header.Get("X-Release-Sync"), name, sum, size) {
		return "", "", 0, false
	}
	return name, sum, size, true
}

// storeVerifiedPackage 把同步内容写入安装包目录。
//
// 参数：name/sum/size 为期望身份，body 为文件字节。
// 返回值：写入并核对成功返回 nil。
// 注意事项：内容与已有正确文件相同时不改动原文件；不一致时用校验后的临时文件替换。
func (s *Server) storeVerifiedPackage(name, sum string, size int64, body io.Reader) error {
	if !s.StorageAvailable() || !storageKeyPattern.MatchString(name) {
		return fmt.Errorf("storage unavailable")
	}
	destination := filepath.Join(s.cfg.ReleaseDir, name)
	file, err := os.CreateTemp(s.cfg.ReleaseDir, ".peer-*")
	if err != nil {
		return err
	}
	temp := file.Name()
	defer os.Remove(temp)
	defer file.Close()
	hash := sha256.New()
	written, err := io.Copy(io.MultiWriter(file, hash), body)
	if err != nil {
		return err
	}
	if written != size || hex.EncodeToString(hash.Sum(nil)) != sum {
		return fmt.Errorf("checksum mismatch")
	}
	if err = file.Sync(); err != nil {
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	if packageFileMatches(destination, size, sum) {
		return nil
	}
	return os.Rename(temp, destination)
}

// packageFileMatches 核对已有文件的大小和 SHA256。
//
// 参数：path/size/sum 为路径和期望身份。
// 返回值：完全一致时为 true。
// 注意事项：文件不存在返回 false，不把它当成校验失败以外的成功。
func packageFileMatches(path string, size int64, sum string) bool {
	if !localPackageSize(path, size) {
		return false
	}
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	hash := sha256.New()
	if _, err = io.Copy(hash, file); err != nil {
		return false
	}
	return hex.EncodeToString(hash.Sum(nil)) == sum
}
