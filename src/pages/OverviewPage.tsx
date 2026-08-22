import type { Project } from "../lib/mock-data";
import { Link, useNavigate } from "../router";
import { useRunStore } from "../stores/run-store";
import { MetricCard, PageHeading, emptyElements, emptyFlows, emptyRuns, isTerminalStatus, statusTag } from "./shared";
import { useWorkspaceStore } from "../stores/workspace-store";
import { CheckCircleFilled, ClockCircleOutlined, CodeOutlined, FileSearchOutlined, PlayCircleFilled, PlusOutlined, StopOutlined, UnorderedListOutlined, WarningFilled } from "@ant-design/icons";
import { Button, Empty } from "antd";

export function OverviewPage({ project }: { project: Project }) {
  const navigate = useNavigate();
  const storedRuns = useRunStore((state) => state.apiRuns[project.id]);
  const runs = storedRuns ?? emptyRuns;
  const storedFlows = useWorkspaceStore((state) => state.flowsByProject[project.id]);
  const storedElements = useWorkspaceStore((state) => state.elementsByProject[project.id]);
  const flows = storedFlows ?? emptyFlows;
  const elements = storedElements ?? emptyElements;
  const latest = runs.slice(0, 4);
  const completedRuns = runs.filter((run) => isTerminalStatus(run.status));
  const successfulRuns = completedRuns.filter((run) => run.status === "success");
  const successRate = completedRuns.length
    ? `${Math.round((successfulRuns.length / completedRuns.length) * 100)}%`
    : "-";
  const runningRuns = runs.filter((run) => run.status === "running").length;
  const unstableElements = elements.filter((element) => element.validation === "multiple");
  const failedRuns = runs.filter((run) => run.status === "failed");
  return (
    <>
      <PageHeading
        title="项目概览"
        description="聚焦当前项目的执行健康度与待处理问题。"
        actions={
          <>
            <Button
              icon={<PlusOutlined />}
              onClick={() => navigate(`/project/${project.id}/flows`)}
            >
              新建流程
            </Button>
            <Button
              type="primary"
              icon={<PlayCircleFilled />}
              onClick={() => navigate(`/project/${project.id}/runs`)}
            >
              运行中心
            </Button>
          </>
        }
      />
      <section className="metric-grid">
        <MetricCard
          label="7 日通过率"
          value={successRate}
          detail={`${completedRuns.length} 次已完成的真实运行`}
          tone="success"
          icon={<CheckCircleFilled />}
        />
        <MetricCard
          label="流程总数"
          value={flows.length}
          detail="当前项目的已保存流程"
          icon={<UnorderedListOutlined />}
        />
        <MetricCard
          label="元素资产"
          value={elements.length}
          detail="当前项目的可复用元素"
          icon={<FileSearchOutlined />}
        />
        <MetricCard
          label="运行中"
          value={runningRuns}
          detail={`${runs.length} 次真实运行任务`}
          tone="info"
          icon={<PlayCircleFilled />}
        />
      </section>
      <section className="overview-grid">
        <div className="surface section-block recent-runs">
          <div className="section-title">
            <div>
              <h2>最近运行</h2>
              <span>来自当前项目</span>
            </div>
            <Button
              type="link"
              onClick={() => navigate(`/project/${project.id}/runs`)}
            >
              查看全部
            </Button>
          </div>
          {latest.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无真实运行记录" />
          ) : latest.map((run) => (
            <button
              className="run-summary-row"
              key={run.id}
              onClick={() => navigate(`/project/${project.id}/runs/${run.id}`)}
            >
              <span className={`run-status-dot ${run.status}`} />
              <span className="summary-flow">
                <strong>{run.flowName}</strong>
                <small>
                  {run.id} · {run.startedAt}
                </small>
              </span>
              <span>{statusTag(run.status)}</span>
              <span className="duration">
                <ClockCircleOutlined /> {run.duration}
              </span>
            </button>
          ))}
        </div>
        <div className="surface section-block attention-block">
          <div className="section-title">
            <div>
              <h2>需要关注</h2>
              <span>优先处理稳定性风险</span>
            </div>
          </div>
          {unstableElements.length === 0 && failedRuns.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无需要关注的真实结果" />
          ) : (
            <>
              {unstableElements.slice(0, 1).map((element) => (
                <div className="attention-item" key={element.id}>
                  <span className="attention-icon warning"><WarningFilled /></span>
                  <div>
                    <strong>{element.name} 存在多个定位匹配</strong>
                    <p>请在元素库中优化该元素的定位方式或定位值。</p>
                    <Link to={`/project/${project.id}/elements`}>查看元素</Link>
                  </div>
                </div>
              ))}
              {failedRuns.slice(0, 1).map((run) => (
                <div className="attention-item" key={run.id}>
                  <span className="attention-icon error"><StopOutlined /></span>
                  <div>
                    <strong>{run.flowName} 运行失败</strong>
                    <p>{run.id} 的失败详情已记录在运行报告中。</p>
                    <Link to={`/project/${project.id}/runs/${run.id}`}>查看报告</Link>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </section>
      <section className="surface quick-start">
        <div>
          <span className="eyebrow">快速操作</span>
          <h2>构建下一个可靠的流程</h2>
        </div>
        <div className="quick-actions">
          <Button
            icon={<FileSearchOutlined />}
            onClick={() => navigate(`/project/${project.id}/elements`)}
          >
            添加元素
          </Button>
          <Button
            icon={<CodeOutlined />}
            onClick={() => navigate(`/project/${project.id}/variables`)}
          >
            管理变量
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => navigate(`/project/${project.id}/flows`)}
          >
            新建流程
          </Button>
        </div>
      </section>
    </>
  );
}
