import { WorkspaceSide } from "./shared";
import { Empty } from "antd";

export function TemplatesPage() {
  return (
    <div className="workspace-layout">
      <WorkspaceSide />
      <main className="workspace-main">
        <header className="workspace-header">
          <div>
            <span className="eyebrow">工作空间</span>
            <h1>公共模板</h1>
            <p>跨项目可复用的标准流程资产。</p>
          </div>
        </header>
        <section className="template-grid">
          <Empty description="暂无已发布的公共模板" />
        </section>
      </main>
    </div>
  );
}
