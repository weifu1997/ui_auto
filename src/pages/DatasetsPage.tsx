import { message } from "../antd-feedback";
import type { Project } from "../mock-data";
import { archivePlatformDataset, getPlatformDatasetVersion, getPlatformDatasets, importPlatformDataset, importPlatformDatasetVersion } from "../platform-api";
import type { PlatformDataset, PlatformDatasetVersion, PlatformSession } from "../platform-api";
import { readPlatformProjectMap, readStoredPlatformSession } from "../platform-context";
import { PageHeading, PlatformProjectRequired, readFileAsBase64 } from "./shared";
import { DeleteOutlined, FileSearchOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Empty, Form, Input, Modal, Popconfirm, Space, Table, Tooltip } from "antd";
import type { TableColumnsType } from "antd";
import { useCallback, useEffect, useState } from "react";

export function DatasetsPage({ project }: { project: Project }) {
  const [platformSession] = useState<PlatformSession | undefined>(readStoredPlatformSession);
  const [platformProjectMap] = useState<Record<string, string>>(readPlatformProjectMap);
  const [datasets, setDatasets] = useState<PlatformDataset[]>([]);
  const [loading, setLoading] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [versionTarget, setVersionTarget] = useState<PlatformDataset>();
  const [preview, setPreview] = useState<{ version: PlatformDatasetVersion; rows: Array<{ rowNumber: number; data: Record<string, string> }>; truncated: boolean }>();
  const [importFile, setImportFile] = useState<File>();
  const [versionFile, setVersionFile] = useState<File>();
  const [submitting, setSubmitting] = useState(false);
  const [importForm] = Form.useForm();
  const platformProjectId = platformProjectMap[project.id];

  const loadDatasets = useCallback(async () => {
    if (!platformSession || !platformProjectId) return;
    setLoading(true);
    try {
      const response = await getPlatformDatasets(platformSession.token, platformProjectId);
      setDatasets(response.datasets);
    } catch {
      message.error("无法读取平台数据集");
    } finally {
      setLoading(false);
    }
  }, [platformProjectId, platformSession]);

  useEffect(() => { void loadDatasets(); }, [loadDatasets]);

  const previewVersion = async (dataset: PlatformDataset) => {
    if (!platformSession || !platformProjectId || !dataset.latestVersion) return;
    try {
      const response = await getPlatformDatasetVersion(platformSession.token, platformProjectId, dataset.latestVersion.id);
      setPreview(response);
    } catch {
      message.error("无法读取数据集版本");
    }
  };

  const upload = async (target?: PlatformDataset) => {
    if (!platformSession || !platformProjectId) return;
    const file = target ? versionFile : importFile;
    if (!file) {
      message.warning("请选择 CSV 或 Excel 文件");
      return;
    }
    setSubmitting(true);
    try {
      const contentBase64 = await readFileAsBase64(file);
      if (target) {
        await importPlatformDatasetVersion(platformSession.token, platformProjectId, target.id, { fileName: file.name, contentBase64 });
        setVersionTarget(undefined);
        setVersionFile(undefined);
        message.success("已创建新的数据集版本");
      } else {
        const values = await importForm.validateFields();
        await importPlatformDataset(platformSession.token, platformProjectId, { ...values, fileName: file.name, contentBase64 });
        importForm.resetFields();
        setImportFile(undefined);
        setImportOpen(false);
        message.success("数据集已导入并冻结为版本 1");
      }
      await loadDatasets();
    } catch {
      message.error("数据集导入失败，请检查表头、文件大小和平台连接");
    } finally {
      setSubmitting(false);
    }
  };

  if (!platformSession || !platformProjectId) {
    return <PlatformProjectRequired project={project} title="数据集" description="将 CSV 或 Excel 表格导入为可复现的数据集版本。" />;
  }

  const columns: TableColumnsType<PlatformDataset> = [
    { title: "数据集", dataIndex: "name", render: (name: string, item) => <span><strong>{name}</strong><small className="table-secondary">{item.description || "无说明"}</small></span> },
    { title: "最新版本", width: 120, render: (_, item) => item.latestVersion ? `v${item.latestVersion.versionNumber}` : "-" },
    { title: "行数", width: 90, render: (_, item) => item.latestVersion?.rowCount ?? 0 },
    { title: "列", width: 220, render: (_, item) => item.latestVersion?.columns.join(" · ") ?? "-" },
    { title: "更新于", dataIndex: "updatedAt", width: 180, render: (value: string) => new Date(value).toLocaleString() },
    {
      title: "",
      width: 150,
      render: (_, item) => <Space size={2}>
        <Tooltip title="预览冻结版本"><Button icon={<FileSearchOutlined />} aria-label={`预览 ${item.name} 冻结版本`} onClick={() => void previewVersion(item)} disabled={!item.latestVersion} /></Tooltip>
        <Tooltip title="导入新版本"><Button icon={<ReloadOutlined />} aria-label={`导入 ${item.name} 新版本`} onClick={() => { setVersionFile(undefined); setVersionTarget(item); }} /></Tooltip>
        <Popconfirm title="归档该数据集？" description="历史运行仍会保留已冻结的数据版本。" onConfirm={() => archivePlatformDataset(platformSession.token, platformProjectId, item.id).then(loadDatasets).then(() => message.success("数据集已归档")).catch(() => message.error("数据集归档失败"))}><Tooltip title="归档"><Button danger aria-label={`归档数据集 ${item.name}`} icon={<DeleteOutlined />} /></Tooltip></Popconfirm>
      </Space>,
    },
  ];

  return (
    <>
      <PageHeading title="数据集" description="导入后生成不可变版本；参数化执行时每行独立创建一个运行快照。" actions={<Space><Tooltip title="刷新数据集"><Button icon={<ReloadOutlined />} aria-label="刷新数据集" loading={loading} onClick={() => void loadDatasets()} /></Tooltip><Button type="primary" icon={<PlusOutlined />} onClick={() => { importForm.resetFields(); setImportFile(undefined); setImportOpen(true); }}>导入数据集</Button></Space>} />
      <section className="surface project-table">
        <Table rowKey="id" columns={columns} dataSource={datasets} loading={loading} pagination={false} locale={{ emptyText: <Empty description="尚未导入数据集" /> }} />
      </section>
      <Modal title="导入数据集" open={importOpen} confirmLoading={submitting} okText="导入并创建版本" onCancel={() => setImportOpen(false)} onOk={() => void upload()}>
        <Form form={importForm} layout="vertical">
          <Form.Item name="name" label="数据集名称" rules={[{ required: true, message: "请输入数据集名称" }]}><Input autoFocus /></Form.Item>
          <Form.Item name="description" label="说明"><Input /></Form.Item>
          <Form.Item label="CSV 或 Excel" required extra="首行作为表头；最多 10,000 行。">
            <Input type="file" accept=".csv,.xlsx" onChange={(event) => setImportFile(event.target.files?.[0])} />
          </Form.Item>
        </Form>
      </Modal>
      <Modal title={`导入 ${versionTarget?.name ?? ""} 的新版本`} open={Boolean(versionTarget)} confirmLoading={submitting} okText="创建版本" onCancel={() => setVersionTarget(undefined)} onOk={() => versionTarget && void upload(versionTarget)}>
        <Form layout="vertical"><Form.Item label="CSV 或 Excel" required extra="既有版本不会被覆盖。"><Input type="file" accept=".csv,.xlsx" onChange={(event) => setVersionFile(event.target.files?.[0])} /></Form.Item></Form>
      </Modal>
      <Modal title={preview ? `版本 ${preview.version.versionNumber} 预览` : "数据预览"} open={Boolean(preview)} footer={<Button onClick={() => setPreview(undefined)}>关闭</Button>} onCancel={() => setPreview(undefined)} width={760}>
        {preview && <Table size="small" rowKey="rowNumber" pagination={false} scroll={{ x: true, y: 360 }} dataSource={preview.rows.map((row) => ({ key: row.rowNumber, ...row.data }))} columns={preview.version.columns.map((column) => ({ title: column, dataIndex: column, width: 180 }))} />}
        {preview?.truncated && <Alert className="dataset-preview-alert" type="info" showIcon title="预览仅显示前 100 行。" />}
      </Modal>
    </>
  );
}
