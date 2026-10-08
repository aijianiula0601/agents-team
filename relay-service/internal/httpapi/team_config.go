package httpapi

import (
	"encoding/json"
	"net/http"

	"agents-team-relay/internal/service"
)

// mutateAgentConfig 接收 Agent 新建和删除请求。
//
// 参数：标准 HTTP 参数；创建正文含 id、baseRevision、config，删除仅含 baseRevision。
// 返回值：成功时输出完整快照及版本；错误沿用统一响应。
// 注意事项：适用于同账号全部设备，路径与实际执行均属于主电脑。
func (s *Server) mutateAgentConfig(w http.ResponseWriter, r *http.Request) {
	s.mutateTeamConfig(w, r, "agents")
}

// mutateRoomConfig 接收团队的新建、编辑和删除请求。
//
// 参数：标准 HTTP 参数；正文含 baseRevision，创建另含 id，创建与编辑另含 config。
// 返回值：成功时输出完整快照及版本；错误沿用统一响应。
// 注意事项：成员存在性和并发任务由业务层在账号锁内检查。
func (s *Server) mutateRoomConfig(w http.ResponseWriter, r *http.Request) {
	s.mutateTeamConfig(w, r, "rooms")
}

// patchSharedSettings 接收影响主电脑执行的非敏感共享设置。
//
// 参数：请求正文含 baseRevision 和 config。
// 返回值：完整快照及新版本。
// 注意事项：仅允许 localExecution 和 defaultProvider，不接受密钥和设备偏好。
func (s *Server) patchSharedSettings(w http.ResponseWriter, r *http.Request) {
	s.mutateTeamConfig(w, r, "settings")
}

// mutateTeamConfig 统一配置变更的认证、请求解析及版本响应。
//
// 参数：collection 由固定路由传入，不能由正文任意指定。
// 返回值：无；写入 HTTP 状态及 JSON 响应。
// 注意事项：删除携带配置、编辑携带实体 id 等歧义请求会被拒绝。
func (s *Server) mutateTeamConfig(w http.ResponseWriter, r *http.Request, collection string) {
	device, _, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	var req struct {
		BaseRevision int64           `json:"baseRevision"`
		ID           string          `json:"id"`
		Config       json.RawMessage `json:"config"`
	}
	if !decodeBody(w, r, 66560, &req) {
		return
	}
	input := service.TeamConfigMutation{Collection: collection, ID: r.PathValue("id"), BaseRevision: req.BaseRevision, Config: req.Config}
	switch r.Method {
	case http.MethodPost:
		input.Action, input.ID = "create", req.ID
	case http.MethodPatch:
		input.Action = "update"
	case http.MethodDelete:
		input.Action = "delete"
	}
	if r.Method != http.MethodPost && req.ID != "" {
		writeError(w, http.StatusBadRequest, "INVALID", "修改和删除的编号只能来自请求路径")
		return
	}
	saved, err := s.service.MutateTeamConfig(r.Context(), device, input)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"revision": saved.Revision, "state": json.RawMessage(saved.Body)})
}
