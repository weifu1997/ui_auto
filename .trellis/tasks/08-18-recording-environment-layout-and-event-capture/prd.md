# 修复录制环境布局与步骤捕获

## Goal

让测试人员在开始录制前能清晰选择环境和填写起始 URL；录制浏览器中的按钮、链接及其内部文字或图标时，生成指向实际可交互元素的可执行步骤。

## Background And Evidence

- 开始录制弹窗的 `.recording-form` 与字段标签没有专属布局规则，两个 label 以浏览器默认的 inline 布局落在同一行，环境 Select 与起始 URL 标签发生重叠，见 `src/FlowEditorPage.tsx:782`、`src/App.css`。
- 浏览器注入脚本将 `event.target` 直接作为录制目标；点击 button、a 或其子元素时，若事件来自内部 span/svg，将生成子节点 descriptor，丢失按钮或链接的语义定位，见 `server-py/autoflow/recorder.py:86`、`:136`。
- `RecorderNormalizer` 已支持以 role/name、testid、label、text、CSS 的优先级生成元素定位，故本修复只应向其传入正确的交互元素，不改变步骤和元素 DTO，见 `server-py/autoflow/recorder.py:384`。

## Requirements

### R1 Start Form Layout

- 开始录制表单的环境和起始 URL 作为独立纵向字段展示，字段标签在控件上方。
- Select 和 Input 填满弹窗的可用内容宽度；复选框独占一行。
- 保持现有字段名称、aria-label、默认环境、URL 校验和开始录制 API 请求不变。

### R2 Semantic Click Capture

- click、keydown、unsupported 事件从事件源向上解析到最近的语义交互元素：button、a[href]、input、textarea、select，或带显式 role 的元素。
- 若不存在上述祖先，保留原事件源，避免丢弃现有普通元素点击。
- 解析后的 descriptor 必须保留其 testid、role、accessible name、label、CSS 等信息，并由既有 normalizer 生成正确的步骤和元素。
- 不改变 input/change 的值采集、敏感字段脱敏、iframe 忽略、暂停/继续或导航归并行为。

## Acceptance Criteria

- [x] AC1：在桌面和窄视口下打开“开始录制”弹窗，环境选择器、起始 URL 输入框和“从头录制”复选框无重叠；环境和 URL 标签各自在对应控件正上方，控件占满表单宽度。（`tests/recording.spec.ts` 在桌面与 480px 视口检查字段边界框和全宽。）
- [x] AC2：选择环境、填写 URL、勾选“从头录制”后，现有前端回归仍向 recording session API 提交所选环境、URL 和 `freshLogin`。（`tests/recording.spec.ts` 断言请求 payload。）
- [x] AC3：在真实 Chromium 录制中点击 button/a 内的嵌套文本或图标，结果步骤引用 button/a 本身的 testid 或 role/name，而非子 span/svg 的 CSS；生成步骤可由现有运行器执行。（`test_recorder_poc.py` 覆盖嵌套文本、SVG path 与 ManagedRunner 重放。）
- [x] AC4：录制普通填写、下拉选择、勾选、键盘按键、iframe warning、敏感输入脱敏和导航归并的现有测试继续通过。（`npm run test:py` 107 passed，专项和回归检查均通过。）

## Out Of Scope

- 不新增录制动作、元素定位策略或 FlowStep/ElementAsset 持久字段。
- 不更改环境 API、登录态复用、权限校验或录制会话生命周期。
- 不处理 Shadow DOM、iframe 交互或 contenteditable 的录制支持；它们仍按现有 warning 策略处理。

## Risks And Deferred Items

- 祖先解析必须限定在当前 document 中，不能跨 iframe 或 Shadow DOM 边界，避免绕过现有不支持行为。
- 用户报告未包含可复现页面；因此以嵌套 button/a 的真实 Chromium 回归覆盖已确认的错误目标路径，并保留现有全动作回归作为兼容证据。
