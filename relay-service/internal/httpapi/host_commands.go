package httpapi

import (
	"context"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"agents-team-relay/internal/logx"
	"agents-team-relay/internal/realtime"
	"agents-team-relay/internal/service"
	"agents-team-relay/internal/storage"

	"github.com/google/uuid"
)

const hostCommandTTL = 3 * time.Minute

// hostConfigKey 描述在线主电脑的临时公钥。参数来自主设备；返回时删除发布会话摘要；不保存私钥。
type hostConfigKey struct {
	AccountID      string    `json:"accountId"`
	TargetDeviceID string    `json:"targetDeviceId"`
	KeyID          string    `json:"keyId"`
	PublicKey      string    `json:"publicKey"`
	ExpiresAt      time.Time `json:"expiresAt,omitempty"`
	PublisherHash  string    `json:"publisherHash,omitempty"`
	Generation     string    `json:"generation"`
}

// hostCommand 只保留三分钟配置请求。参数为受限动作和正文；结果不含密钥；不会进入 MySQL 聊天或广播正文。
type hostCommand struct {
	ID             string          `json:"id"`
	AccountID      string          `json:"accountId"`
	SourceDeviceID string          `json:"sourceDeviceId"`
	SourceHash     string          `json:"sourceHash,omitempty"`
	TargetDeviceID string          `json:"targetDeviceId"`
	KeyID          string          `json:"keyId"`
	Generation     string          `json:"generation,omitempty"`
	Action         string          `json:"action"`
	Payload        json.RawMessage `json:"payload,omitempty"`
	Status         string          `json:"status"`
	ExpiresAt      time.Time       `json:"expiresAt"`
	ClaimHash      string          `json:"claimHash,omitempty"`
	ClaimToken     string          `json:"claimToken,omitempty"`
	ClaimExpiresAt time.Time       `json:"claimExpiresAt,omitempty"`
	RequestHash    string          `json:"requestHash,omitempty"`
	Result         json.RawMessage `json:"result,omitempty"`
	ErrorMessage   string          `json:"errorMessage,omitempty"`
}

// hostConfigError 生成可安全展示的错误。参数为状态码和中文说明；返回业务错误；不包含配置正文。
func hostConfigError(status int, message string) error {
	return &service.Error{Status: status, Code: "HOST_CONFIG", Message: message}
}

// withHostAccount 在账号锁内重新认证后访问 Redis。参数为请求和操作；直接写响应；锁与切换主设备共享，避免跨节点竞争。
func (s *Server) withHostAccount(w http.ResponseWriter, r *http.Request, operation func(storage.Device, storage.Tx) (any, error)) {
	device, _, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	if s.hub == nil {
		writeServiceError(w, hostConfigError(503, "主电脑配置通道暂不可用"))
		return
	}
	var response any
	err := s.store.WithAccount(r.Context(), device.AccountID, func(tx storage.Tx) error {
		current, err := tx.Device(r.Context(), device.ID)
		if errors.Is(err, storage.ErrNotFound) || err == nil && (current.Revoked || current.TokenHash == "" || current.TokenHash != device.TokenHash) {
			return hostConfigError(401, "设备登录已失效")
		}
		if err != nil {
			return err
		}
		response, err = operation(current, tx)
		return err
	})
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

// loadHostKey 读取当前有效的主电脑公钥。参数为账号锁和账号；返回已复核主角色与登录版本的公钥；过期、换主或注销立即失效。
func (s *Server) loadHostKey(ctx context.Context, tx storage.Tx, accountID string) (hostConfigKey, error) {
	var key hostConfigKey
	raw, err := s.hub.GetTransient(ctx, "host-key:"+accountID)
	if realtime.IsTransientMissing(err) {
		return key, hostConfigError(409, "主电脑未连接或版本较旧，请保持最新版本的主电脑在线")
	}
	if err != nil {
		return key, err
	}
	if json.Unmarshal([]byte(raw), &key) != nil || !key.ExpiresAt.After(time.Now()) {
		return key, hostConfigError(409, "主电脑配置连接已过期，请稍后重试")
	}
	device, err := tx.Device(ctx, key.TargetDeviceID)
	if err != nil || !device.IsPrimary || device.Revoked || device.TokenHash != key.PublisherHash {
		return key, hostConfigError(409, "主电脑已改变，请刷新连接后重试")
	}
	return key, nil
}

// getHostConfigKey 返回同账号主电脑的公开加密参数。参数为认证请求；返回公钥；不返回发布者令牌摘要。
func (s *Server) getHostConfigKey(w http.ResponseWriter, r *http.Request) {
	s.withHostAccount(w, r, func(device storage.Device, tx storage.Tx) (any, error) {
		key, err := s.loadHostKey(r.Context(), tx, device.AccountID)
		if err != nil {
			return nil, err
		}
		key.PublisherHash = ""
		return map[string]any{"key": key}, nil
	})
}

// putHostConfigKey 刷新主电脑短期公钥。参数为公开身份；返回公开身份；拒绝非主电脑、过弱密钥和伪造目标。
func (s *Server) putHostConfigKey(w http.ResponseWriter, r *http.Request) {
	var input struct {
		AccountID      string `json:"accountId"`
		TargetDeviceID string `json:"targetDeviceId"`
		KeyID          string `json:"keyId"`
		PublicKey      string `json:"publicKey"`
	}
	if !decodeBody(w, r, 8192, &input) {
		return
	}
	der, err := base64.StdEncoding.DecodeString(input.PublicKey)
	if err != nil {
		writeServiceError(w, hostConfigError(400, "主电脑公钥格式无效"))
		return
	}
	parsed, err := x509.ParsePKIXPublicKey(der)
	public, ok := parsed.(*rsa.PublicKey)
	if err != nil || !ok || public.N.BitLen() < 2048 || public.N.BitLen() > 4096 || public.E != 65537 || !validHostID(input.KeyID) {
		writeServiceError(w, hostConfigError(400, "主电脑公钥格式无效"))
		return
	}
	s.withHostAccount(w, r, func(device storage.Device, _ storage.Tx) (any, error) {
		if !device.IsPrimary || !storage.CanExecute(device.Platform) || input.AccountID != device.AccountID || input.TargetDeviceID != device.ID {
			return nil, hostConfigError(403, "只有当前主电脑可以发布配置连接")
		}
		key := hostConfigKey{AccountID: device.AccountID, TargetDeviceID: device.ID, KeyID: input.KeyID, PublicKey: input.PublicKey, PublisherHash: device.TokenHash, ExpiresAt: time.Now().UTC().Add(90 * time.Second)}
		key.Generation = uuid.NewString()
		if raw, err := s.hub.GetTransient(r.Context(), "host-key:"+device.AccountID); err == nil {
			var previous hostConfigKey
			if json.Unmarshal([]byte(raw), &previous) == nil && previous.TargetDeviceID == device.ID && previous.KeyID == key.KeyID && previous.PublisherHash == device.TokenHash && previous.PublicKey == key.PublicKey && previous.Generation != "" {
				key.Generation = previous.Generation
			}
		} else if !realtime.IsTransientMissing(err) {
			return nil, err
		}
		body, _ := json.Marshal(key)
		if err := s.hub.PutTransient(r.Context(), "host-key:"+device.AccountID, string(body), 90*time.Second); err != nil {
			return nil, err
		}
		key.PublisherHash = ""
		return map[string]any{"key": key}, nil
	})
}

// deleteHostConfigKey 清除本设备旧公钥。参数为认证请求；返回完成状态；不会删除新主电脑的连接。
func (s *Server) deleteHostConfigKey(w http.ResponseWriter, r *http.Request) {
	s.withHostAccount(w, r, func(device storage.Device, _ storage.Tx) (any, error) {
		raw, err := s.hub.GetTransient(r.Context(), "host-key:"+device.AccountID)
		if realtime.IsTransientMissing(err) {
			return map[string]bool{"cleared": true}, nil
		}
		if err != nil {
			return nil, err
		}
		var key hostConfigKey
		if json.Unmarshal([]byte(raw), &key) == nil && key.TargetDeviceID == device.ID && key.PublisherHash == device.TokenHash {
			_, err = s.hub.TakeTransient(r.Context(), "host-key:"+device.AccountID)
		}
		return map[string]bool{"cleared": true}, err
	})
}

// createHostCommand 将配置操作加入短期队列。参数为白名单动作；返回无正文的状态；模型密钥只能以加密信封进入 Redis。
func (s *Server) createHostCommand(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ID             string          `json:"id"`
		Action         string          `json:"action"`
		Payload        json.RawMessage `json:"payload"`
		TargetDeviceID string          `json:"targetDeviceId"`
		KeyID          string          `json:"keyId"`
		Generation     string          `json:"generation"`
	}
	if !decodeBody(w, r, 100*1024, &input) {
		return
	}
	if !validHostID(input.ID) || !validHostID(input.KeyID) || validateHostPayload(input.Action, input.Payload) != nil {
		writeServiceError(w, hostConfigError(400, "主电脑配置操作或参数无效"))
		return
	}
	s.withHostAccount(w, r, func(device storage.Device, tx storage.Tx) (any, error) {
		key, err := s.loadHostKey(r.Context(), tx, device.AccountID)
		if err != nil {
			return nil, err
		}
		if key.TargetDeviceID != input.TargetDeviceID || key.KeyID != input.KeyID || key.Generation != input.Generation {
			return nil, hostConfigError(409, "主电脑配置连接已改变，请重试")
		}
		requestHash := hostRequestHash(input.Action, input.TargetDeviceID, input.KeyID, input.Payload)
		if existing, err := s.loadHostCommand(r.Context(), device.AccountID, input.ID); err == nil {
			if existing.SourceDeviceID != device.ID || existing.SourceHash != device.TokenHash || existing.RequestHash != requestHash || existing.Generation != key.Generation {
				return nil, hostConfigError(409, "配置请求编号已使用")
			}
			return map[string]any{"command": hostCommandView(existing)}, nil
		} else if !realtime.IsTransientMissing(err) {
			return nil, err
		}
		if !s.hub.AllowAttempt(r.Context(), "host-config:"+device.AccountID, 60, time.Minute) {
			return nil, hostConfigError(429, "配置请求过于频繁，请稍后重试")
		}
		queue, err := s.hostQueue(r.Context(), device.AccountID)
		if err != nil {
			return nil, err
		}
		if len(queue) >= 32 {
			return nil, hostConfigError(429, "主电脑待处理配置过多，请稍后重试")
		}
		command := hostCommand{ID: input.ID, AccountID: device.AccountID, SourceDeviceID: device.ID, SourceHash: device.TokenHash, TargetDeviceID: input.TargetDeviceID, KeyID: input.KeyID, Generation: key.Generation, Action: input.Action, Payload: input.Payload, RequestHash: requestHash, Status: "pending", ExpiresAt: time.Now().UTC().Add(hostCommandTTL)}
		if err := s.saveHostCommandQueue(r.Context(), command, append(queue, command.ID)); err != nil {
			return nil, err
		}
		logx.Infof("主电脑配置入队 account=" + device.AccountID + " action=" + command.Action)
		s.hub.Publish(r.Context(), realtime.Event{AccountID: device.AccountID, Type: "host-config.updated"})
		return map[string]any{"command": hostCommandView(command)}, nil
	})
}

// claimHostCommand 独占领取本主电脑的命令。参数为主设备请求；返回一次性领取令牌；同账号锁确保跨节点不重复领取。
func (s *Server) claimHostCommand(w http.ResponseWriter, r *http.Request) {
	s.withHostAccount(w, r, func(device storage.Device, tx storage.Tx) (any, error) {
		if !device.IsPrimary {
			return nil, hostConfigError(403, "只有主电脑可以领取配置")
		}
		key, err := s.loadHostKey(r.Context(), tx, device.AccountID)
		if err != nil {
			return nil, err
		}
		queue, err := s.hostQueue(r.Context(), device.AccountID)
		if err != nil {
			return nil, err
		}
		for index := 0; index < len(queue); {
			id := queue[index]
			command, err := s.loadHostCommand(r.Context(), device.AccountID, id)
			if realtime.IsTransientMissing(err) {
				queue = append(queue[:index], queue[index+1:]...)
				continue
			}
			if err != nil {
				return nil, err
			}
			if command.Status == "done" || command.Status == "failed" {
				queue = append(queue[:index], queue[index+1:]...)
				continue
			}
			source, err := tx.Device(r.Context(), command.SourceDeviceID)
			if err != nil || source.Revoked || source.TokenHash != command.SourceHash || command.TargetDeviceID != device.ID || command.KeyID != key.KeyID || command.Generation != key.Generation {
				command.Status = "failed"
				command.ErrorMessage = "登录或主电脑已变化，请重新保存"
				command.Payload = nil
				if err := s.saveHostCommand(r.Context(), command); err != nil {
					return nil, err
				}
				queue = append(queue[:index], queue[index+1:]...)
				continue
			}
			// 领取响应丢失时，在短租约后重新交付同一编号；主进程按编号去重，已保存操作不会重复执行。
			if command.Status == "running" && command.ClaimExpiresAt.After(time.Now()) {
				index++
				continue
			}
			command.Status = "running"
			command.ClaimExpiresAt = time.Now().UTC().Add(45 * time.Second)
			token := uuid.NewString() + uuid.NewString()
			digest := sha256.Sum256([]byte(token))
			command.ClaimHash = hex.EncodeToString(digest[:])
			if err := s.saveHostCommandQueue(r.Context(), command, queue); err != nil {
				return nil, err
			}
			command.ClaimToken = token
			command.ClaimHash = ""
			command.SourceHash = ""
			command.RequestHash = ""
			return map[string]any{"command": command}, nil
		}
		if err := s.saveHostQueue(r.Context(), device.AccountID, queue); err != nil {
			return nil, err
		}
		return map[string]any{"command": nil}, nil
	})
}

// getHostCommand 让发起设备等待结果。参数为请求编号；返回脱敏状态；其他同账号设备也不能读取此结果。
func (s *Server) getHostCommand(w http.ResponseWriter, r *http.Request) {
	s.withHostAccount(w, r, func(device storage.Device, tx storage.Tx) (any, error) {
		command, err := s.loadHostCommand(r.Context(), device.AccountID, r.PathValue("id"))
		if realtime.IsTransientMissing(err) {
			return nil, hostConfigError(410, "配置请求已过期，请刷新主电脑设置")
		}
		if err != nil {
			return nil, err
		}
		if command.SourceDeviceID != device.ID || command.SourceHash != device.TokenHash {
			return nil, hostConfigError(404, "配置请求不存在")
		}
		if command.Status == "pending" || command.Status == "running" {
			key, err := s.loadHostKey(r.Context(), tx, device.AccountID)
			if err != nil {
				return nil, err
			}
			if key.TargetDeviceID != command.TargetDeviceID || key.KeyID != command.KeyID || key.Generation != command.Generation {
				return nil, hostConfigError(409, "主电脑配置连接已变化，请重新保存")
			}
		}
		return map[string]any{"command": hostCommandView(command)}, nil
	})
}

// completeHostCommand 写回原生配置结果。参数为领取令牌及结果；返回脱敏状态；拒绝过期、换主、越权和重复变更结果。
func (s *Server) completeHostCommand(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ClaimToken   string          `json:"claimToken"`
		Result       json.RawMessage `json:"result"`
		ErrorMessage string          `json:"errorMessage"`
	}
	if !decodeBody(w, r, 256*1024, &input) {
		return
	}
	s.withHostAccount(w, r, func(device storage.Device, tx storage.Tx) (any, error) {
		if !device.IsPrimary {
			return nil, hostConfigError(403, "只有主电脑可以确认配置")
		}
		command, err := s.loadHostCommand(r.Context(), device.AccountID, r.PathValue("id"))
		if realtime.IsTransientMissing(err) {
			return nil, hostConfigError(410, "配置请求已过期")
		}
		if err != nil {
			return nil, err
		}
		key, err := s.loadHostKey(r.Context(), tx, device.AccountID)
		if err != nil {
			return nil, err
		}
		digest := sha256.Sum256([]byte(input.ClaimToken))
		claimHash := hex.EncodeToString(digest[:])
		if command.TargetDeviceID != device.ID || command.KeyID != key.KeyID || command.Generation != key.Generation || input.ClaimToken == "" || subtle.ConstantTimeCompare([]byte(claimHash), []byte(command.ClaimHash)) != 1 {
			return nil, hostConfigError(403, "配置领取已失效")
		}
		if command.Status == "done" || command.Status == "failed" {
			return map[string]any{"command": hostCommandView(command)}, nil
		}
		if !command.ClaimExpiresAt.After(time.Now()) {
			return nil, hostConfigError(409, "配置领取已过期，请重新领取确认")
		}
		if command.Status != "running" {
			return nil, hostConfigError(409, "配置尚未领取")
		}
		if input.ErrorMessage != "" {
			if len(input.ErrorMessage) > 3000 {
				return nil, hostConfigError(400, "错误说明过长")
			}
			command.Status = "failed"
			command.ErrorMessage = input.ErrorMessage
		} else {
			result, err := sanitizeHostResult(command.Action, input.Result)
			if err != nil {
				return nil, err
			}
			command.Status = "done"
			command.Result = result
		}
		command.Payload = nil
		if err := s.saveHostCommand(r.Context(), command); err != nil {
			return nil, err
		}
		logx.Infof("主电脑配置完成 account=" + device.AccountID + " action=" + command.Action + " status=" + command.Status)
		s.hub.Publish(r.Context(), realtime.Event{AccountID: device.AccountID, Type: "host-config.updated"})
		return map[string]any{"command": hostCommandView(command)}, nil
	})
}

// validHostID 限制键片段为 UUID。参数为外部编号；返回是否合法；防止任意 Redis 键访问。
func validHostID(value string) bool {
	_, err := uuid.Parse(value)
	return err == nil && len(value) == 36
}

// loadHostCommand 读取账号内单条短期命令。参数为账号和编号；返回命令或缺失；不跨账号查询。
func (s *Server) loadHostCommand(ctx context.Context, accountID, id string) (hostCommand, error) {
	var command hostCommand
	if !validHostID(id) {
		return command, hostConfigError(400, "配置请求编号无效")
	}
	raw, err := s.hub.GetTransient(ctx, "host-command:"+accountID+":"+id)
	if err != nil {
		return command, err
	}
	err = json.Unmarshal([]byte(raw), &command)
	return command, err
}

// saveHostCommand 保存原有截止时间内的状态。参数为命令；返回存储错误；回写不会延长三分钟有效期。
func (s *Server) saveHostCommand(ctx context.Context, command hostCommand) error {
	ttl := time.Until(command.ExpiresAt)
	if ttl <= 0 {
		return hostConfigError(410, "配置请求已过期")
	}
	body, err := json.Marshal(command)
	if err != nil {
		return err
	}
	return s.hub.PutTransient(ctx, "host-command:"+command.AccountID+":"+command.ID, string(body), ttl)
}

// saveHostCommandQueue 原子更新命令及账号队列。参数为命令与编号列表；返回 Redis 事务错误；任一失败不能留下孤立 pending/running 状态。
func (s *Server) saveHostCommandQueue(ctx context.Context, command hostCommand, queue []string) error {
	ttl := time.Until(command.ExpiresAt)
	if ttl < time.Millisecond {
		return hostConfigError(410, "配置请求已过期")
	}
	body, err := json.Marshal(command)
	if err != nil {
		return err
	}
	queued, _ := json.Marshal(queue)
	return s.hub.PutTransients(ctx, []realtime.TransientWrite{{Key: "host-command:" + command.AccountID + ":" + command.ID, Body: string(body), TTL: ttl}, {Key: "host-queue:" + command.AccountID, Body: string(queued), TTL: hostCommandTTL}})
}

// hostRequestHash 对语义相同的请求生成稳定摘要。参数为动作、目标、公钥及 JSON 正文；返回摘要；幂等编号不能被不同操作重复使用。
func hostRequestHash(action, target, keyID string, payload json.RawMessage) string {
	var value any
	json.Unmarshal(payload, &value)
	canonical, _ := json.Marshal([]any{action, target, keyID, value})
	digest := sha256.Sum256(canonical)
	return hex.EncodeToString(digest[:])
}

// hostQueue 读取账号短期命令编号队列。参数为账号；返回队列；调用方必须持有账号锁。
func (s *Server) hostQueue(ctx context.Context, accountID string) ([]string, error) {
	raw, err := s.hub.GetTransient(ctx, "host-queue:"+accountID)
	if realtime.IsTransientMissing(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var queue []string
	err = json.Unmarshal([]byte(raw), &queue)
	return queue, err
}

// saveHostQueue 保存有界短期队列。参数为账号及编号列表；返回存储错误；账号锁提供跨节点串行化。
func (s *Server) saveHostQueue(ctx context.Context, accountID string, queue []string) error {
	body, _ := json.Marshal(queue)
	return s.hub.PutTransient(ctx, "host-queue:"+accountID, string(body), hostCommandTTL)
}

// hostCommandView 删除请求正文和会话摘要。参数为内部命令；返回源设备可见状态；不广播命令正文。
func hostCommandView(command hostCommand) hostCommand {
	command.Payload = nil
	command.ClaimHash = ""
	command.ClaimToken = ""
	command.SourceHash = ""
	command.RequestHash = ""
	return command
}

// validateHostPayload 验证固定动作和参数。参数为动作及 JSON；返回校验错误；所有模型写入只接受加密信封。
func validateHostPayload(action string, payload json.RawMessage) error {
	var values map[string]json.RawMessage
	if json.Unmarshal(payload, &values) != nil || values == nil {
		return errors.New("invalid payload")
	}
	allowed := map[string]int{}
	switch action {
	case "settings.get", "model.get", "harness.get", "harness.probe":
	case "harness.save":
		allowed = map[string]int{"codex": 4096, "claude": 4096, "cursor": 4096}
	case "harness.models":
		allowed = map[string]int{"harness": 20}
	case "workspace.normalize":
		allowed = map[string]int{"path": 4096}
	case "model.save":
		allowed = map[string]int{"algorithm": 32, "key": 1024, "iv": 32, "data": 96 * 1024}
	default:
		return errors.New("invalid action")
	}
	for key, raw := range values {
		limit, ok := allowed[key]
		var text string
		if !ok || json.Unmarshal(raw, &text) != nil || len(text) > limit || strings.ContainsRune(text, 0) {
			return errors.New("invalid value")
		}
	}
	if action == "harness.models" {
		var harness string
		if json.Unmarshal(values["harness"], &harness) != nil || harness != "codex" && harness != "claude" && harness != "cursor" {
			return errors.New("invalid harness")
		}
	}
	if action == "model.save" {
		var envelope struct {
			Algorithm string `json:"algorithm"`
			Key       string `json:"key"`
			IV        string `json:"iv"`
			Data      string `json:"data"`
		}
		json.Unmarshal(payload, &envelope)
		key, keyErr := base64.StdEncoding.DecodeString(envelope.Key)
		iv, ivErr := base64.StdEncoding.DecodeString(envelope.IV)
		data, dataErr := base64.StdEncoding.DecodeString(envelope.Data)
		if envelope.Algorithm != "RSA-OAEP-256/A256GCM" || keyErr != nil || len(key) < 256 || len(key) > 512 || ivErr != nil || len(iv) != 12 || dataErr != nil || len(data) < 17 {
			return errors.New("invalid envelope")
		}
	}
	return nil
}

// sanitizeHostResult 按动作重建公开结果。参数为动作及原生结果；返回白名单 JSON；未知字段和密钥不会回传。
func sanitizeHostResult(action string, raw json.RawMessage) (json.RawMessage, error) {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return nil, hostConfigError(400, "主电脑配置结果无效")
	}
	var result any
	switch action {
	case "model.get", "model.save":
		result = filterHostObject(value, []string{"openaiConfigured", "anthropicConfigured", "customConfigured", "ollamaBase"})
	case "harness.get":
		result = filterHostObject(value, []string{"codex", "claude", "cursor"})
	case "harness.probe":
		result = filterHostProbes(value)
	case "harness.save":
		object, _ := value.(map[string]any)
		result = map[string]any{"paths": filterHostObject(object["paths"], []string{"codex", "claude", "cursor"}), "probe": filterHostProbes(object["probe"])}
	case "settings.get":
		object, _ := value.(map[string]any)
		result = map[string]any{"modelSettings": filterHostObject(object["modelSettings"], []string{"openaiConfigured", "anthropicConfigured", "customConfigured", "ollamaBase"}), "harnessPaths": filterHostObject(object["harnessPaths"], []string{"codex", "claude", "cursor"}), "harnessStatus": filterHostProbes(object["harnessStatus"])}
	case "harness.models":
		object, _ := value.(map[string]any)
		models, _ := object["models"].([]any)
		if len(models) > 500 {
			return nil, hostConfigError(400, "模型目录过大")
		}
		clean := make([]any, 0, len(models))
		for _, model := range models {
			clean = append(clean, filterHostObject(model, []string{"id", "label", "description"}))
		}
		result = filterHostObject(value, []string{"source", "error"})
		result.(map[string]any)["models"] = clean
	case "workspace.normalize":
		text, ok := value.(string)
		if !ok || len(text) > 4096 {
			return nil, hostConfigError(400, "工作区结果无效")
		}
		result = text
	default:
		return nil, hostConfigError(400, "配置结果动作无效")
	}
	body, err := json.Marshal(result)
	return body, err
}

// filterHostObject 复制公开标量字段。参数为对象及字段名；返回安全对象；不复制嵌套未知密钥或对象。
func filterHostObject(value any, fields []string) map[string]any {
	object, _ := value.(map[string]any)
	clean := map[string]any{}
	for _, key := range fields {
		switch field := object[key].(type) {
		case string:
			if len(field) <= 8192 {
				clean[key] = field
			}
		case bool:
			clean[key] = field
		case nil:
			if _, ok := object[key]; ok {
				clean[key] = nil
			}
		}
	}
	return clean
}

// filterHostProbes 复制三种内核检测结果。参数为检测对象；返回公开状态；不允许额外内核或秘密字段。
func filterHostProbes(value any) map[string]any {
	object, _ := value.(map[string]any)
	clean := map[string]any{}
	for _, name := range []string{"codex", "claude", "cursor"} {
		clean[name] = filterHostObject(object[name], []string{"available", "path", "version", "authenticated", "error"})
	}
	return clean
}
