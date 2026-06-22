# 声随 shengsui.top

会听你说话的免费在线提词器。

## 功能

- 导入 TXT、Markdown、SRT，或直接粘贴口播稿
- 根据识别出的口播内容定位字幕，而不是固定速度滚动
- 支持停顿、重说、向前或向后跳读
- 点击任意句后选择“从这开始”
- 支持镜像、字号调整和全屏提词
- 界面支持中文、English、日本語实时切换，识别语言同步切换
- 移动端支持自动、竖屏和横屏显示
- 稿件保存在浏览器本地

## 本地预览

麦克风功能需要安全上下文，请使用 localhost，而不是直接双击 HTML：

```bash
python3 -m http.server 4174
```

访问 `http://localhost:4174/`。

## GitHub Pages

仓库使用 `main` 分支根目录作为 GitHub Pages 来源，`CNAME` 已设置为 `shengsui.top`。

DNS 设置：

- 根域名添加 A 记录，指向 GitHub Pages 的四个地址；
- `www` 添加 CNAME，指向 `hanjin714.github.io`；
- 在 GitHub Pages 设置中开启 HTTPS。
