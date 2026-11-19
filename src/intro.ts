/**
 * 内置介绍页：固定在插件里，任何用户初始化库时都会补进库根
 * （对齐 WorkBuddy 资料库的内置介绍 HTML）。
 * 缺了就补（重启后删除会被还原）；已存在的内容绝不覆盖，用户改过的保留。
 */

const STYLE = `
  <style>
    body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0; padding: 48px 56px; color: #1f2329; line-height: 1.75; background: #fff; }
    h1 { font-size: 26px; margin: 0 0 8px; }
    h2 { font-size: 17px; margin: 32px 0 8px; padding-left: 10px; border-left: 3px solid #3370ff; }
    p, li { font-size: 14px; color: #4e5566; }
    .sub { color: #8f959e; font-size: 14px; margin: 0 0 24px; }
    .card { background: #f5f6f7; border-radius: 10px; padding: 16px 20px; margin: 12px 0; }
    .card b { color: #1f2329; }
    code { background: #eff0f1; border-radius: 4px; padding: 1px 6px; font-size: 13px; }
  </style>`

export const INTRO_FILES: readonly { name: string; html: string }[] = [
  {
    name: '欢迎使用资料库.html',
    html: `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>欢迎使用资料库</title>${STYLE}</head>
<body>
  <h1>欢迎使用资料库</h1>
  <p class="sub">dsh-wb-desk · 你的 Agent 产物自动归档处</p>

  <h2>这是什么</h2>
  <p>资料库是 Agent 工作产物的家。Agent 在对话中生成的文件会自动收进来，你在这里统一查看、预览、整理，不用再到处找文件。</p>

  <h2>三分钟上手</h2>
  <div class="card"><b>本地产物</b> —— 左侧菜单点「本地产物」，按工作区 → 会话分组看 Agent 刚生成的文件，点任意文件右侧抽屉直接预览内容。</div>
  <div class="card"><b>我的资料</b> —— 库里的全部文件。支持搜索、按类型筛选、收藏、重命名、移动、删除（删除进回收站，可恢复）。</div>
  <div class="card"><b>新建</b> —— 左侧菜单点「新建」，直接创建 Markdown / CSV / HTML / Word / Excel / PPT，也能上传文件、添加链接、新建文件夹。</div>

  <h2>文件从哪来</h2>
  <p>Agent 用写入工具产出的文件，会自动复制一份到本库的 <code>inbox/</code> 目录，原处的文件不受影响。只有插件安装之后产生的会话产物才会收录，历史产物不回填。</p>
</body>
</html>`,
  },
  {
    name: '功能指南.html',
    html: `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>功能指南</title>${STYLE}</head>
<body>
  <h1>功能指南</h1>
  <p class="sub">dsh-wb-desk · 进阶能力一览</p>

  <h2>修改要确认，绝不直接覆盖</h2>
  <p>Agent 想改库里<b>已有</b>的文件时，改动不会直接落盘，而是进入左侧菜单的「待确认」队列。你逐条看过之后，接受才写入，拒绝就丢弃。新文件则免确认直接进来。</p>

  <h2>固定引用（pin）</h2>
  <p>你引用了某个文件之后它又被改了？读取时插件会给你 pin 时刻的版本并提示漂移，避免基于过期内容做决策。在面板底部「固定引用」里可以查看和释放。</p>

  <h2>云同步（腾讯云 COS）</h2>
  <p>左侧菜单底部「云同步」里填入 COS 的地址、Bucket、密钥即可启用。语义刻意简单：本地永远是主库，云端是镜像；按修改时间新盖旧；删除不传播（任一端删文件不会影响另一端）。开启自动推送后，每次写入 5 秒后自动同步。</p>

  <h2>回收站</h2>
  <p>删除的文件先进 <code>.dsh-library/.trash/</code>，误删可以手动捞回；清空回收站才彻底删除。</p>

  <h2>这两个介绍页</h2>
  <p>它们是普通 HTML 文件，就在库根目录。看完可以直接删除，插件不会重新生成。</p>
</body>
</html>`,
  },
] as const
