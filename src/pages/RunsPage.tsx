import { message } from "../antd-feedback";
import type { Project, Run } from "../mock-data";
import { cancelPlatformRun, createPlatformRun, getPlatformRun, getPlatformRuns } from "../platform-api";
import type { PlatformSession } from "../platform-api";
import { readPlatformProjectMap, readStoredPlatformSession } from "../platform-context";
import { useNavigate } from "../router";
import { useRunStore } from "../run-store";
import { useWorkspaceStore } from "../workspace-store";
import { PageHeading, canUseCapability, emptyRuns, isTerminalStatus, isWorkerRunId, platformRunAsRun, reportRetryError, statusMeta, statusTag, usePolling, watchWorkerRun, workerTaskAsRun } from "./shared";
import { cancelRun, getRun, retryRun } from "../worker-api";
import { ReloadOutlined, StopOutlined } from "@ant-design/icons";
import { Button, Empty, Progress, Select, Space, Table, Tooltip } from "antd";
import type { TableColumnsType } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";

export function RunsPage({ project }: { project: Project }) {
  const navigate = useNavigate();
  const canExecuteRun = canUseCapability("run.execute");
  const watchCleanups = useRef<Array<() => void>>([]);
  useEffect(() => () => {
    for (const cleanup of watchCleanups.current) cleanup();
    watchCleanups.current = [];
  }, []);
  const [platformSession] = useState<PlatformSession | undefined>(readStoredPlatformSession);
  const legacyPlatformProjectId = readPlatformProjectMap()[project.id];
  const enablePlatformProject = useWorkspaceStore((state) => state.enablePlatformProject);
  const platformProjectId = useWorkspaceStore((state) =>
    state.projectModesById?.[project.id] === "platform-enabled"
      ? state.platformProjectIdsById?.[project.id]
      : undefined,
  );
  const storedApiRuns = useRunStore((state) => state.apiRuns[project.id]);
  const apiRuns = storedApiRuns ?? emptyRuns;
  const upsertRun = useRunStore((state) => state.upsertRun);
  useEffect(() => {
    const cleanups = new Map<string, () => void>();
    const subscribe = (runs: Run[]) => {
      for (const run of runs) {
        if (!isWorkerRunId(run.id) || isTerminalStatus(run.status)) continue;
        if (cleanups.has(run.id)) continue;
        cleanups.set(run.id, watchWorkerRun(project.id, run, upsertRun));
      }
    };
    const unsubscribeStore = useRunStore.subscribe((state) => {
      subscribe(state.apiRuns[project.id] ?? []);
    });
    subscribe(useRunStore.getState().apiRuns[project.id] ?? []);
    return () => {
      unsubscribeStore();
      for (const cleanup of cleanups.values()) cleanup();
    };
  }, [project.id, upsertRun]);
  const [filter, setFilter] = useState("all");
  const [updatingRunId, setUpdatingRunId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    if (platformSession && legacyPlatformProjectId && !platformProjectId) {
      enablePlatformProject(project.id, legacyPlatformProjectId);
    }
  }, [enablePlatformProject, legacyPlatformProjectId, platformProjectId, platformSession, project.id]);
  const refreshPlatformRuns = useCallback(async () => {
    if (!platformSession || !platformProjectId || !window.location.pathname.endsWith("/platform")) return;
    try {
      const response = await getPlatformRuns(platformSession.token, platformProjectId);
      response.runs.forEach((run) => upsertRun(project.id, platformRunAsRun(run)));
    } catch {
      // The legacy Worker run center remains usable when Platform is offline.
    }
  }, [platformProjectId, platformSession, project.id, upsertRun]);
  useEffect(() => {
    void refreshPlatformRuns();
  }, [refreshPlatformRuns]);
  usePolling(refreshPlatformRuns, 3_000);
  const filtered =
    filter === "all" ? apiRuns : apiRuns.filter((run) => run.status === filter);
  const cancel = async (run: Run) => {
    setUpdatingRunId(run.id);
    try {
      if (isWorkerRunId(run.id)) {
        const task = await cancelRun(project.id, run.id);
        upsertRun(project.id, workerTaskAsRun(task, run));
        message.info("运行已停止，浏览器窗口已关闭。");
      } else if (platformSession && platformProjectId) {
        const response = await cancelPlatformRun(platformSession.token, platformProjectId, run.id);
        upsertRun(project.id, platformRunAsRun(response.run));
        message.info("已向 Agent 发送取消请求。");
      } else {
        throw new Error("PLATFORM_SESSION_REQUIRED");
      }
    } catch {
      message.error("取消运行失败，请稍后重试");
    } finally {
      setUpdatingRunId(null);
    }
  };
  const retry = async (run: Run) => {
    setUpdatingRunId(run.id);
    try {
      if (!isWorkerRunId(run.id)) {
        if (!platformSession || !platformProjectId) throw new Error("PLATFORM_SESSION_REQUIRED");
        const prior = await getPlatformRun(platformSession.token, platformProjectId, run.id);
        const created = await createPlatformRun(platformSession.token, platformProjectId, {
          revisionId: prior.run.revisionId,
          environmentId: prior.run.environmentId,
        });
        created.runs.forEach((platformRun) => upsertRun(project.id, platformRunAsRun(platformRun)));
        if (created.runIds[0]) navigate(`/project/${project.id}/runs/${created.runIds[0]}`);
        message.success("已重新提交给指定 Agent");
        return;
      }
      const { runId } = await retryRun(project.id, run.id);
      const retriedRun: Run = {
        ...run,
        id: runId,
        status: "queued",
        progress: 0,
        completedSteps: 0,
        startedAt: "刚刚",
        duration: "排队中",
        screenshots: 0,
        retries: run.retries + 1,
      };
      upsertRun(project.id, retriedRun);
      watchCleanups.current.push(watchWorkerRun(project.id, retriedRun, upsertRun));
      message.success("已重新提交给 Playwright Worker");
      navigate(`/project/${project.id}/runs/${runId}`);
    } catch (error) {
      if (!reportRetryError(error)) message.error("重新提交失败，请稍后重试");
    } finally {
      setUpdatingRunId(null);
    }
  };
  const refresh = async () => {
    const workerRuns = apiRuns.filter((run) => isWorkerRunId(run.id));
    if (workerRuns.length === 0 && !platformProjectId) {
      message.info("当前没有需要刷新的 Worker 运行任务");
      return;
    }
    setRefreshing(true);
    const results = await Promise.allSettled([
      ...workerRuns.map(async (run) => {
        const task = await getRun(project.id, run.id);
        upsertRun(project.id, workerTaskAsRun(task, run));
      }),
      ...(platformSession && platformProjectId ? [
        getPlatformRuns(platformSession.token, platformProjectId).then((response) => {
          response.runs.forEach((platformRun) => upsertRun(project.id, platformRunAsRun(platformRun)));
        }),
      ] : []),
    ]);
    setRefreshing(false);
    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed === 0) message.success("运行状态已刷新");
    else message.warning(`已刷新 ${results.length - failed} 条运行，${failed} 条暂不可用`);
  };
  const columns: TableColumnsType<Run> = [
    {
      title: "运行任务",
      dataIndex: "id",
      render: (_, run) => (
        <button
          className="run-link"
          onClick={() => navigate(`/project/${project.id}/runs/${run.id}`)}
        >
          <span className={`run-status-dot ${run.status}`} />
          <span>
            <strong>{run.flowName}</strong>
            <small>{run.id}</small>
          </span>
        </button>
      ),
    },
    { title: "状态", dataIndex: "status", width: 120, render: statusTag },
    { title: "环境", dataIndex: "environment", width: 120 },
    {
      title: "进度",
      dataIndex: "progress",
      width: 175,
      render: (progress, run) => (
        <div className="run-progress">
          <Progress
            percent={progress}
            showInfo={false}
            size="small"
            status={
              run.status === "failed"
                ? "exception"
                : run.status === "success"
                  ? "success"
                  : "active"
            }
          />
          <span>
            {run.completedSteps}/{run.totalSteps}
          </span>
        </div>
      ),
    },
    { title: "开始时间", dataIndex: "startedAt", width: 165 },
    { title: "耗时", dataIndex: "duration", width: 100 },
    {
      title: "",
      key: "actions",
      width: 96,
      render: (_, run) =>
        canExecuteRun
          ? (
            !isTerminalStatus(run.status) ? (
              <Tooltip title="取消运行">
                <Button
                  type="text"
                  danger
                  icon={<StopOutlined />}
                  aria-label={`取消运行 ${run.flowName}`}
                  loading={updatingRunId === run.id}
                  onClick={() => void cancel(run)}
                />
              </Tooltip>
            ) : (
              <Tooltip title="重新运行">
                <Button
                  type="text"
                  icon={<ReloadOutlined />}
                  aria-label={`重新运行 ${run.flowName}`}
                  loading={updatingRunId === run.id}
                  onClick={() => void retry(run)}
                />
              </Tooltip>
            )
          )
          : null,
    },
  ];
  return (
    <>
      <PageHeading
        title="运行中心"
        description="查看当前与历史执行任务。实时状态通过 Worker 事件持续刷新。"
        actions={
          <Button
            icon={<ReloadOutlined />}
            loading={refreshing}
            onClick={() => void refresh()}
          >
            刷新状态
          </Button>
        }
      />
      <div className="run-filter">
        <Space>
          <span>状态</span>
          <Select
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "全部" },
              ...Object.entries(statusMeta).map(([value, meta]) => ({
                value,
                label: meta.label,
              })),
            ]}
          />
        </Space>
        <span className="live-note">
          <i /> 实时更新已开启
        </span>
      </div>
      <section className="surface">
        <Table
          rowKey="id"
          columns={columns}
          dataSource={filtered}
          pagination={{ pageSize: 8, showSizeChanger: false }}
          locale={{ emptyText: <Empty description="尚无真实运行任务" /> }}
        />
      </section>
    </>
  );
}
