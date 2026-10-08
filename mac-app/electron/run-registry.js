/** 管理页面发起的后台任务；页面关闭或用户停止时同一信号传到模型请求与 CLI。 */
class RunRegistry {
  constructor() {
    this.runs = new Map();
  }

  async run(runId, action) {
    const id = normalizeRunId(runId, true) || Symbol("run");
    if (this.runs.has(id)) throw new Error("这个任务编号正在运行");
    const controller = new AbortController();
    this.runs.set(id, controller);
    try {
      const result = await action(controller.signal);
      if (controller.signal.aborted) throw new Error("任务已停止");
      return result;
    } finally {
      this.runs.delete(id);
    }
  }

  cancel(runId) {
    const controller = this.runs.get(normalizeRunId(runId));
    if (!controller || controller.signal.aborted) return { cancelled: false };
    controller.abort();
    return { cancelled: true };
  }

  cancelAll() {
    for (const controller of this.runs.values()) controller.abort();
  }
}

function normalizeRunId(value, optional = false) {
  if (optional && (value === undefined || value === null || value === "")) return "";
  if (typeof value !== "string" || !value.trim() || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("任务编号格式无效");
  }
  return value;
}

module.exports = { RunRegistry };
