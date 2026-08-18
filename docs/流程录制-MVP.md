# 流程录制 MVP

流程录制在流程编辑器中启动部署机上的有头 Chromium。录制结果先进入编辑器草稿，用户确认后才追加到流程和元素库；录制不会自动保存或发布。

## 支持的动作

- 打开页面、站内直接导航和常见 SPA 路由变化
- 点击按钮、链接和具有唯一定位器的元素
- 填写、清空非敏感文本输入
- 下拉选择、勾选和有意义的键盘按键（Enter、Escape、Tab 等）

录制步骤可在确认导入前编辑。元素会按定位器规范复用；无法确认唯一性的定位器必须先处理，才能导入。

## 明确不支持

MVP 不会把以下行为生成为可执行步骤，会显示 warning：iframe 内操作、多标签页或 popup、Shadow DOM、文件上传/下载、拖拽、contenteditable、hover、双击以及外域页面操作。外域导航本身只产生 warning，不会把外域事件写入流程。

## 登录态与会话

默认复用同项目、同环境的 Picker 登录态快照。选择“从头录制”或没有可用 Picker 会话时，会创建全新的浏览器 context，需要在录制窗口中重新登录。录制只读使用 Picker 快照，不会回写 Picker 的 storage；停止、取消、过期或刷新服务后，录制 context、页面和浏览器都会回收，并在界面显示明确终态。

刷新编辑器只恢复 `sessionId` 和控制状态。事件、步骤结果、DOM 或登录态不会写入浏览器 storage；过期或服务关闭时恢复会失败并显示错误，可重新开始录制。

## 敏感输入

password、token、secret 等敏感输入的原值不会进入录制 API、事件响应、前端 storage、服务端日志、审计或 revision snapshot。停止后必须把每个敏感步骤绑定到项目或环境中的 secret 变量；未绑定不能确认导入。保存的步骤只包含完整模板，例如 `{{project.API_TOKEN}}` 或 `{{env.PASSWORD}}`，不会保存明文。

非敏感输入的值可以在确认前修改。请勿在普通文本框中输入密码或其他密钥来绕过绑定流程。

## URL 与安全边界

起始 URL 必须是 HTTP(S)、不含 userinfo，并与所选环境的 `baseUrl` 同源（包括端口）。录制产生的 URL 只保留 scheme、host 和 path；query、fragment 不会进入步骤、事件、日志或审计。依赖 query 的页面状态需要在导入后手工补充步骤。

## 保存与运行

1. 点击“停止”进入 review，处理 warning、定位器和 secret 绑定。
2. 点击确认导入，结果一次性追加到当前流程草稿；取消 review 不修改流程或元素库。
3. 使用编辑器现有“保存”提交 revision，再按项目发布流程发布。
4. 发布后由 Platform `ManagedRunner` 执行。录制本身不创建绕过 revision 或 secret 契约的运行入口。
