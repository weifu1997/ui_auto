import { message } from "../lib/antd-feedback";
import type { Project, Run } from "../lib/mock-data";
import { cancelPlatformRun, cancelPlatformRunBatch, createPlatformRun, deletePlatformRun, deletePlatformRuns, getPlatformRun, getPlatformRunBatch, getPlatformRunBatches, getPlatformRuns, retryPlatformRun, retryPlatformRunBatch } from "../api/platform-api";
import type { PlatformRunBatch, PlatformRunBatchItem, PlatformSession } from "../api/platform-api";

import { readPlatformProjectMap, readStoredPlatformSession } from "../api/platform-context";
import { useLocation, useNavigate } from "../router";
import { useRunStore } from "../stores/run-store";
import { useWorkspaceStore } from "../stores/workspace-store";
import { FilterBar, FilterItem, PageHeading, canUseCapability, isTerminalStatus, nextRunDispatchKey, platformRunAsRun, releaseRunDispatchKey, reportRetryError, runIntentKey, statusMeta, statusTag, usePolling } from "./shared";
import { DeleteOutlined, ReloadOutlined, StopOutlined } from "@ant-design/icons";
import { Button, Empty, Input, Popconfirm, Progress, Select, Space, Table, Tag, Tooltip } from "antd";
import type { TableColumnsType } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
const batchStatusMeta = {
  queued: { label: "排队中", color: "default" },
  running: { label: "运行中", color: "processing" },
  success: { label: "全部通过", color: "success" },
  partial_failed: { label: "部分失败", color: "warning" },
  failed: { label: "失败", color: "error" },
  canceled: { label: "已取消", color: "default" },
} as const;


export function RunsPage({ project }: { project: Project }) {
  const navigate = useNavigate();
  const location = useLocation();
  const canExecuteRun = canUseCapability("run.execute");
  const [platformSession] = useState<PlatformSession | undefined>(readStoredPlatformSession);
  const legacyPlatformProjectId = readPlatformProjectMap()[project.id];
  const setPlatformProjectId = useWorkspaceStore((state) => state.setPlatformProjectId);
  const platformProjectId = useWorkspaceStore((state) => state.platformProjectIdsById?.[project.id]);
  const remotePlatformProjectId = platformProjectId ?? legacyPlatformProjectId ?? project.id;
  const upsertRun = useRunStore((state) => state.upsertRun);
  const [filter, setFilter] = useState(() => new URLSearchParams(location.search).get("status") ?? "all");
  const [flowFilter, setFlowFilter] = useState(() => new URLSearchParams(location.search).get("flow") ?? "");
  const [sourceFilter, setSourceFilter] = useState(() => new URLSearchParams(location.search).get("source") ?? "all");
  const [fromFilter, setFromFilter] = useState(() => new URLSearchParams(location.search).get("from") ?? "");
  const [toFilter, setToFilter] = useState(() => new URLSearchParams(location.search).get("to") ?? "");
  const [page, setPage] = useState(() => Math.max(1, Number(new URLSearchParams(location.search).get("page") ?? "1") || 1));
  const [batchPage, setBatchPage] = useState(() => Math.max(1, Number(new URLSearchParams(location.search).get("batchPage") ?? "1") || 1));
  const [platformPageRuns, setPlatformPageRuns] = useState<Run[]>([]);
  const [platformTotal, setPlatformTotal] = useState(0);
  const [updatingRunId, setUpdatingRunId] = useState<string | null>(null);
  const runDispatchKeysRef = useRef(new Map<string, string>());
  const [refreshing, setRefreshing] = useState(false);
  const [batches, setBatches] = useState<PlatformRunBatch[]>([]);
  const [batchTotal, setBatchTotal] = useState(0);
  const [batchItems, setBatchItems] = useState<Record<string, PlatformRunBatchItem[]>>({});
  const [expandedBatchIds, setExpandedBatchIds] = useState<string[]>(() => {
    const target = new URLSearchParams(window.location.search).get("batch");
    return target ? [target] : [];
  });
  const [batchUpdatingId, setBatchUpdatingId] = useState<string | null>(null);
  const [selectedRunIds, setSelectedRunIds] = useState<string[]>([]);
  const [batchDeleting, setBatchDeleting] = useState(false);
  useEffect(() => {
    if (platformSession && legacyPlatformProjectId && !platformProjectId) {
      setPlatformProjectId(project.id, legacyPlatformProjectId);
    }
  }, [legacyPlatformProjectId, platformProjectId, platformSession, project.id, setPlatformProjectId]);

  const refreshPlatformRuns = useCallback(async () => {
    if (!platformSession || !remotePlatformProjectId) return;
    try {
      const response = await getPlatformRuns(platformSession.token, remotePlatformProjectId, {
        page,
        pageSize: 8,
        status: filter === "all" ? undefined : filter,
        flow: flowFilter || undefined,
        source: sourceFilter === "all" ? undefined : sourceFilter as "manual" | "schedule" | "webhook",
        from: fromFilter || undefined,
        to: toFilter || undefined,
      });
      const pageRuns = response.runs.map((run) => platformRunAsRun(run));
      setPlatformPageRuns(pageRuns);
      setPlatformTotal(response.total);
      pageRuns.forEach((run) => upsertRun(project.id, run));
    } catch {
      message.error("平台运行列表加载失败，请稍后重试");
    }
  }, [filter, flowFilter, fromFilter, page, platformSession, project.id, remotePlatformProjectId, sourceFilter, toFilter, upsertRun]);
  useEffect(() => {
    void refreshPlatformRuns();
  }, [refreshPlatformRuns]);
  const loadBatchItems = useCallback(async (batchId: string) => {
    if (!platformSession || !remotePlatformProjectId) return;
    try {
      const detail = await getPlatformRunBatch(
        platformSession.token, remotePlatformProjectId, batchId,
      );
      setBatchItems((current) => ({ ...current, [batchId]: detail.runs }));
    } catch {
      // 展开的批次详情加载失败时保留已有数据，列表仍可用。
    }
  }, [platformSession, remotePlatformProjectId]);
  const refreshBatches = useCallback(async () => {
    if (!platformSession || !remotePlatformProjectId) return;
    try {
      const response = await getPlatformRunBatches(
        platformSession.token, remotePlatformProjectId, { page: batchPage, pageSize: 20 },
      );
      setBatches(response.batches);
      setBatchTotal(response.total);
      const stale = expandedBatchIds.filter(
        (batchId) => response.batches.some((batch) => batch.id === batchId),
      );
      for (const batchId of stale) {
        await loadBatchItems(batchId);
      }
    } catch {
      // 批次列表轮询失败时保留上次结果，不影响单运行视图。
    }
  }, [batchPage, expandedBatchIds, loadBatchItems, platformSession, remotePlatformProjectId]);
  useEffect(() => {
    void refreshBatches();
  }, [refreshBatches]);
  const hasActivePlatformRuns = platformPageRuns.some((run) => !isTerminalStatus(run.status));
  const hasActiveBatches = batches.some(
    (batch) => batch.status === "queued" || batch.status === "running",
  );
  const pollInterval = platformSession && remotePlatformProjectId
    ? hasActivePlatformRuns || hasActiveBatches ? 3_000 : 15_000
    : 0;
  usePolling(refreshPlatformRuns, pollInterval);
  usePolling(refreshBatches, pollInterval);
  const cancelBatch = async (batch: PlatformRunBatch) => {
    if (!platformSession || !remotePlatformProjectId) return;
    setBatchUpdatingId(batch.id);
    try {
      const response = await cancelPlatformRunBatch(
        platformSession.token, remotePlatformProjectId, batch.id,
      );
      setBatches((current) => current.map(
        (item) => (item.id === response.batch.id ? response.batch : item),
      ));
      setBatchItems((current) => ({ ...current, [response.batch.id]: response.runs }));
      message.info("已请求取消批次中未完成的运行");
    } catch {
      message.error("取消批次失败，请稍后重试");
    } finally {
      setBatchUpdatingId(null);
    }
  };
  const retryBatch = async (batch: PlatformRunBatch) => {
    if (!platformSession || !remotePlatformProjectId) return;
    setBatchUpdatingId(batch.id);
    try {
      const response = await retryPlatformRunBatch(
        platformSession.token, remotePlatformProjectId, batch.id, crypto.randomUUID(),
      );
      message.success("已创建重试批次，失败与取消项将按原版本快照重新执行");
      setExpandedBatchIds([response.batch.id]);
      setBatchPage(1);
      await refreshBatches();
    } catch (error) {
      if (error instanceof Error && error.message === "BATCH_NOT_RETRYABLE") {
        message.error("该批次当前不可重试");
      } else {
        message.error("重试批次失败，请稍后重试");
      }
    } finally {
      setBatchUpdatingId(null);
    }
  };

  useEffect(() => {
    const params = new URLSearchParams();
    if (page > 1) params.set("page", String(page));
    if (filter !== "all") params.set("status", filter);
    if (flowFilter) params.set("flow", flowFilter);
    if (sourceFilter !== "all") params.set("source", sourceFilter);
    if (fromFilter) params.set("from", fromFilter);
    if (toFilter) params.set("to", toFilter);
    if (batchPage > 1) params.set("batchPage", String(batchPage));
    if (expandedBatchIds[0]) params.set("batch", expandedBatchIds[0]);
    const search = params.toString();
    navigate(`${location.pathname}${search ? `?${search}` : ""}`, { replace: true });
  }, [batchPage, expandedBatchIds, filter, flowFilter, fromFilter, location.pathname, navigate, page, sourceFilter, toFilter]);
  const dataSource = platformPageRuns;
  const cancel = async (run: Run) => {
    setUpdatingRunId(run.id);
    try {
      if (platformSession && remotePlatformProjectId) {
        const response = await cancelPlatformRun(platformSession.token, remotePlatformProjectId, run.id);
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
    let intent: string | undefined;
    try {
      if (platformSession && remotePlatformProjectId) {
        const prior = await getPlatformRun(platformSession.token, remotePlatformProjectId, run.id);
        const flowId = (prior.run.snapshot.flow as { id?: unknown } | undefined)?.id;
        let created;
        if (prior.run.status === "success") {
          if (typeof flowId !== "string" || !flowId) throw new Error("PLATFORM_FRESH_RUN_FLOW_REQUIRED");
          intent = runIntentKey({ projectId: remotePlatformProjectId, flowId });
          const dispatchKey = nextRunDispatchKey(runDispatchKeysRef.current, intent);
          created = await createPlatformRun(platformSession.token, remotePlatformProjectId, {
            flowId,
            environmentId: prior.run.environmentId,
            dispatchKey,
          });
          releaseRunDispatchKey(runDispatchKeysRef.current, intent);
        } else {
          intent = runIntentKey({ projectId: remotePlatformProjectId, runId: prior.run.id });
          const dispatchKey = nextRunDispatchKey(runDispatchKeysRef.current, intent);
          created = await retryPlatformRun(platformSession.token, remotePlatformProjectId, prior.run.id, dispatchKey);
          releaseRunDispatchKey(runDispatchKeysRef.current, intent);
        }
        if (prior.run.status === "success" && created.runIds.length === 0) throw new Error("PLATFORM_FRESH_RUN_NOT_CREATED");
        created.runs.forEach((platformRun) => upsertRun(project.id, platformRunAsRun(platformRun)));
        if (created.runIds[0]) navigate(`/project/${project.id}/runs/${created.runIds[0]}`);
        message.success(prior.run.status === "success" ? "已按最新已发布版本创建新运行" : "已按原快照重新提交");
        return;
      } else {
        throw new Error("PLATFORM_SESSION_REQUIRED");
      }
    } catch (error) {
      if (intent) releaseRunDispatchKey(runDispatchKeysRef.current, intent, error);
      if (!reportRetryError(error)) message.error("重新提交失败，请稍后重试");
    } finally {
      setUpdatingRunId(null);
    }
  };
  const refresh = async () => {
    if (!platformSession || !remotePlatformProjectId) {
      message.info("当前项目尚未连接 Platform");
      return;
    }
    setRefreshing(true);
    const results = await Promise.allSettled([refreshPlatformRuns()]);
    setRefreshing(false);
    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed === 0) message.success("运行状态已刷新");
    else message.warning(`已刷新 ${results.length - failed} 条运行，${failed} 条暂不可用`);
  };
  const batchItemColumns: TableColumnsType<PlatformRunBatchItem> = [
    {
      title: "流程运行",
      dataIndex: "flowName",
      render: (_, item) => (
        <button
          className="run-link"
          onClick={() => navigate(`/project/${project.id}/runs/${item.id}`)}
        >
          <span className={`run-status-dot ${item.status}`} />
          <span>
            <strong>{item.flowName ?? item.revisionId}</strong>
            <small>{item.id}</small>
          </span>
        </button>
      ),
    },
    { title: "状态", dataIndex: "status", width: 110, render: statusTag },
    {
      title: "",
      key: "cancellation",
      width: 110,
      render: (_, item) =>
        item.cancellationRequested && !isTerminalStatus(item.status)
          ? <Tag>取消中</Tag>
          : null,
    },
    { title: "开始时间", dataIndex: "createdAt", width: 170 },
  ];
  const batchColumns: TableColumnsType<PlatformRunBatch> = [
    {
      title: "批次",
      dataIndex: "id",
      render: (_, batch) => (
        <span>
          <strong>{batch.retryOfBatchId ? "重试批次" : "批量运行"}（{batch.counts.total} 个流程）</strong>
          <small>{batch.id}</small>
        </span>
      ),
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 110,
      render: (status: PlatformRunBatch["status"]) => {
        const meta = batchStatusMeta[status];
        return <Tag color={meta?.color ?? "default"}>{meta?.label ?? status}</Tag>;
      },
    },
    {
      title: "进度（串行执行）",
      key: "counts",
      width: 260,
      render: (_, batch) => (
        <span>
          {batch.counts.completed}/{batch.counts.total} 完成 · 成功 {batch.counts.success} · 失败 {batch.counts.failed} · 取消 {batch.counts.canceled}
          {batch.status === "running" && batch.cancellationRequested ? " · 取消中" : ""}
        </span>
      ),
    },
    { title: "创建时间", dataIndex: "createdAt", width: 170 },
    {
      title: "",
      key: "actions",
      width: 96,
      render: (_, batch) =>
        canExecuteRun
          ? (
            batch.status === "queued" || batch.status === "running" ? (
              <Tooltip title="取消批次">
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<StopOutlined />}
                  aria-label={`取消批次 ${batch.id}`}
                  loading={batchUpdatingId === batch.id}
                  onClick={() => void cancelBatch(batch)}
                />
              </Tooltip>
            ) : batch.counts.failed + batch.counts.canceled > 0 ? (
              <Tooltip title="重试失败项">
                <Button
                  type="text"
                  size="small"
                  icon={<ReloadOutlined />}
                  aria-label={`重试批次 ${batch.id}`}
                  loading={batchUpdatingId === batch.id}
                  onClick={() => void retryBatch(batch)}
                />
              </Tooltip>
            ) : null
          )
          : null,
    },
  ];
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
            <Space size={0}>
              {!isTerminalStatus(run.status) ? (
                <Tooltip title="取消运行">
                  <Button
                    type="text"
                    size="small"
                    danger
                    icon={<StopOutlined />}
                    aria-label={`取消运行 ${run.flowName}`}
                    loading={updatingRunId === run.id}
                    onClick={() => void cancel(run)}
                  />
                </Tooltip>
              ) : (
                <Tooltip title={run.status === "success" ? "再次运行（新运行）" : "重试"}>
                  <Button
                    type="text"
                    size="small"
                    icon={<ReloadOutlined />}
                    aria-label={`${run.status === "success" ? "再次运行（新运行）" : "重试"} ${run.flowName}`}
                    loading={updatingRunId === run.id}
                    onClick={() => void retry(run)}
                  />
                </Tooltip>
              )}
              {isTerminalStatus(run.status) && (
                <Popconfirm
                  title="删除运行记录"
                  description="确定删除此条运行记录吗？"
                  okText="删除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={async () => {
                    try {
                      if (platformSession && remotePlatformProjectId) {
                        await deletePlatformRun(platformSession.token, remotePlatformProjectId, run.id);
                      }
                      useRunStore.getState().removeRun(project.id, run.id);
                      setPlatformPageRuns((prev) => prev.filter((r) => r.id !== run.id));
                      setPlatformTotal((prev) => Math.max(0, prev - 1));
                      setSelectedRunIds((prev) => prev.filter((id) => id !== run.id));
                      message.success("运行记录已删除");
                    } catch {
                      message.error("运行记录删除失败");
                    }
                  }}
                >
                  <Tooltip title="删除记录">
                    <Button
                      type="text"
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      aria-label={`删除运行 ${run.flowName}`}
                    />
                  </Tooltip>
                </Popconfirm>
              )}
            </Space>
          )
          : null,
    },
  ];
  return (
    <>
      <PageHeading
        title="运行中心"
        description="查看当前与历史执行任务。状态由 Platform 执行服务持续刷新。"
        actions={
          <Space>
            {canExecuteRun && (
              <Popconfirm
                title="批量删除运行记录"
                description={`确定删除选中的 ${selectedRunIds.length} 条运行记录吗？`}
                okText="删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                disabled={selectedRunIds.length === 0}
                onConfirm={async () => {
                  const ids = [...selectedRunIds];
                  setBatchDeleting(true);
                  try {
                    let deletedIds = ids;
                    if (platformSession && remotePlatformProjectId) {
                      const result = await deletePlatformRuns(platformSession.token, remotePlatformProjectId, ids);
                      deletedIds = result.runIds;
                    }
                    useRunStore.getState().removeRuns(project.id, deletedIds);
                    setPlatformPageRuns((prev) => prev.filter((r) => !deletedIds.includes(r.id)));
                    setPlatformTotal((prev) => Math.max(0, prev - deletedIds.length));
                    setSelectedRunIds((prev) => prev.filter((id) => !deletedIds.includes(id)));
                    message.success(`已批量删除 ${deletedIds.length} 条运行记录`);
                  } catch {
                    message.error("批量删除运行记录失败");
                  } finally {
                    setBatchDeleting(false);
                  }
                }}
              >
                <Button
                  danger
                  icon={<DeleteOutlined />}
                  disabled={selectedRunIds.length === 0}
                  loading={batchDeleting}
                >
                  批量删除{selectedRunIds.length > 0 ? `（${selectedRunIds.length}）` : ""}
                </Button>
              </Popconfirm>
            )}
            <Button
              icon={<ReloadOutlined />}
              loading={refreshing}
              onClick={() => void refresh()}
            >
              刷新状态
            </Button>
          </Space>
        }
      />
      <FilterBar
        extra={
          <span className="live-note">
            <i /> 实时更新已开启
          </span>
        }
      >
        <FilterItem label="状态">
          <Select
            value={filter}
            onChange={(value) => { setPage(1); setFilter(value); }}
            style={{ width: 110 }}
            options={[
              { value: "all", label: "全部" },
              ...Object.entries(statusMeta).map(([value, meta]) => ({
                value,
                label: meta.label,
              })),
            ]}
          />
        </FilterItem>
        <FilterItem label="流程">
          <Input
            value={flowFilter}
            aria-label="流程名称"
            placeholder="流程名称"
            style={{ width: 150 }}
            allowClear
            onChange={(event) => { setPage(1); setFlowFilter(event.target.value); }}
          />
        </FilterItem>
        <FilterItem label="来源">
          <Select
            value={sourceFilter}
            aria-label="运行来源"
            style={{ width: 110 }}
            onChange={(value) => { setPage(1); setSourceFilter(value); }}
            options={[
              { value: "all", label: "全部" },
              { value: "manual", label: "手动" },
              { value: "schedule", label: "计划任务" },
              { value: "webhook", label: "Webhook" },
            ]}
          />
        </FilterItem>
        <FilterItem label="开始">
          <Input type="date" aria-label="开始日期" value={fromFilter} onChange={(event) => { setPage(1); setFromFilter(event.target.value); }} />
        </FilterItem>
        <FilterItem label="结束">
          <Input type="date" aria-label="结束日期" value={toFilter} onChange={(event) => { setPage(1); setToFilter(event.target.value); }} />
        </FilterItem>
      </FilterBar>
      {batches.length > 0 && (
        <section className="surface" style={{ marginBottom: 16 }}>
          <Table
            size="small"
            rowKey="id"
            columns={batchColumns}
            dataSource={batches}
            pagination={{
              current: batchPage,
              pageSize: 20,
              total: batchTotal,
              showSizeChanger: false,
              onChange: (nextPage) => setBatchPage(nextPage),
            }}
            expandable={{
              expandedRowKeys: expandedBatchIds,
              onExpand: (expanded, batch) => {
                setExpandedBatchIds((current) => (
                  expanded
                    ? [...current, batch.id]
                    : current.filter((id) => id !== batch.id)
                ));
                if (expanded && !batchItems[batch.id]) void loadBatchItems(batch.id);
              },
              expandedRowRender: (batch) =>
                batchItems[batch.id] ? (
                  <Table
                    size="small"
                    rowKey="id"
                    columns={batchItemColumns}
                    dataSource={batchItems[batch.id]}
                    pagination={false}
                  />
                ) : (
                  <span>批次详情加载中…</span>
                ),
            }}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无批次" /> }}
          />
        </section>
      )}
      <section className="surface">
        <Table
          rowKey="id"
          columns={columns}
          dataSource={dataSource}
          rowSelection={canExecuteRun ? {
            selectedRowKeys: selectedRunIds,
            onChange: (keys) => setSelectedRunIds(keys.map(String)),
            getCheckboxProps: (run) => ({ disabled: !isTerminalStatus(run.status) }),
          } : undefined}
          pagination={{
            current: page,
            pageSize: 8,
            total: platformTotal,
            showSizeChanger: false,
            onChange: (nextPage) => setPage(nextPage),
          }}
          scroll={{ x: "max-content" }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无真实运行任务" /> }}
        />
      </section>

    </>
  );
}
