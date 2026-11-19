/**
 * dsh-wb-desk 网页客户端：侧栏「资料库」图标 + 主面板。
 *
 * UI 按 WorkBuddy「资料库」真实结构复刻（2026-11-19 用户对照 WorkBuddy 客户端口述校正）：
 *   - 左侧菜单：新建（菜单项，下拉出文档/表格/网页/文件夹）/ 最近使用 / 本地产物 / 我的资料 / 待确认（徽标）
 *   - 右侧内容区：我的资料 = 文件夹逐级进入 + 面包屑 + 可排序表头（名称/类型/更新人/更新时间/大小）
 *   - 本地产物：点开为覆盖整页的弹层——左上角「返回资料库」，下方筛选区 +
 *     表头，内容按 工作区 → 会话 分组列出 Agent 产物；点文件右侧滑出抽屉预览
 *   - 待确认：Agent 修改已有文件的审阅队列，行内接受/拒绝
 * 数据来自同源 /dsh-wb-desk/*（host 半 src/routes.ts 注册的路由）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-wb-desk',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef, useMemo } = React

    const API = '/dsh-wb-desk'

    async function api(path, options) {
      const res = await fetch(API + path, options)
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status))
      return body
    }
    const post = (path, payload) => api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })

    /* ── 本地偏好：收藏 ── */
    function loadSet(key) {
      try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')) } catch { return new Set() }
    }
    function saveSet(key, set) {
      try { localStorage.setItem(key, JSON.stringify([...set])) } catch { /* 隐私模式就算了 */ }
    }

    /* ── 图标：线性 SVG（对齐 WorkBuddy 的图标语言，不用 emoji）── */
    function svg(paths, size, filled) {
      return h('svg', {
        width: size || 16, height: size || 16, viewBox: '0 0 24 24',
        fill: filled ? 'currentColor' : 'none',
        stroke: filled ? 'none' : 'currentColor',
        'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        'aria-hidden': true, style: { flexShrink: 0, display: 'block' },
      }, paths.map((d, i) => h('path', { key: i, d })))
    }
    const Icon = {
      folder: (s) => svg(['M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z'], s),
      doc: (s) => svg(['M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z', 'M14 3v5h5', 'M9 12h6M9 16h6'], s),
      sheet: (s) => svg(['M4 4h16v16H4z', 'M4 9h16M4 14h16M9.5 4v16'], s),
      web: (s) => svg(['M8 6l-5 6 5 6', 'M16 6l5 6-5 6', 'M13.5 4l-3 16'], s),
      file: (s) => svg(['M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z', 'M14 3v5h5'], s),
      search: (s) => svg(['M11 5a6 6 0 1 0 0 12 6 6 0 0 0 0-12z', 'M20 20l-4.3-4.3'], s),
      plus: (s) => svg(['M12 5v14', 'M5 12h14'], s),
      refresh: (s) => svg(['M20 11a8 8 0 1 0-2.3 6.3', 'M20 5v6h-6'], s),
      chevron: (s) => svg(['M9 5l7 7-7 7'], s),
      more: (s) => h('svg', {
        width: s || 16, height: s || 16, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true,
        style: { flexShrink: 0, display: 'block' },
      }, [5.5, 12, 18.5].map((cx, i) => h('circle', { key: i, cx, cy: 12, r: 1.6 }))),
      star: (s, on) => svg(['M12 3.6l2.7 5.6 6.1.8-4.5 4.2 1.1 6-5.4-3-5.4 3 1.1-6L3.2 9.4l6.1-.8z'], s, on),
      pin: (s) => svg(['M9 4h6l1 6 3 3v2H5v-2l3-3z', 'M12 15v6'], s),
      back: (s) => svg(['M19 12H5', 'M11 6l-6 6 6 6'], s),
      check: (s) => svg(['M4.5 12.5l5 5L20 6.5'], s),
      x: (s) => svg(['M6 6l12 12', 'M18 6L6 18'], s),
      robot: (s) => svg(['M5 10h14v9H5z', 'M12 10V5', 'M12 3a2 2 0 1 0 0 .01', 'M9 14h.01M15 14h.01'], s),
      clock: (s) => svg(['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3.5 2'], s),
      inbox: (s) => svg(['M4 13l2.7-8h10.6L20 13v6H4z', 'M4 13h5l1.5 2h3L15 13h5'], s),
      list: (s) => svg(['M8 6h13M8 12h13M8 18h13', 'M3.5 6h.01M3.5 12h.01M3.5 18h.01'], s),
      cloud: (s) => svg(['M7 18a4.5 4.5 0 1 1 .7-8.96A6 6 0 0 1 19 11.5 3.75 3.75 0 0 1 18.5 19H7z'], s),
    }

    function fileIcon(name, size) {
      const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
      const colored = (icon, color) => h('span', { style: { color, display: 'inline-flex', flexShrink: 0 } }, icon)
      if (ext === '.md' || ext === '.txt') return Icon.doc(size)
      if (ext === '.docx') return colored(Icon.doc(size), '#2b579a')
      if (ext === '.csv') return Icon.sheet(size)
      if (ext === '.xlsx') return colored(Icon.sheet(size), '#217346')
      if (ext === '.pptx') return colored(Icon.web(size), '#d24726')
      if (ext === '.html' || ext === '.htm') return Icon.web(size)
      return Icon.file(size)
    }
    function typeLabel(name) {
      const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
      if (ext === '.md') return '文档'
      if (ext === '.docx') return 'Word'
      if (ext === '.csv') return '表格'
      if (ext === '.xlsx') return 'Excel'
      if (ext === '.pptx') return 'PPT'
      if (ext === '.html' || ext === '.htm') return '网页'
      if (ext === '.txt') return '文本'
      return '文件'
    }
    function typeOf(name) {
      const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
      if (ext === '.md' || ext === '.txt' || ext === '.docx') return 'doc'
      if (ext === '.csv' || ext === '.xlsx') return 'sheet'
      if (ext === '.html' || ext === '.htm') return 'web'
      return 'other'
    }

    function fmtSize(n) {
      if (typeof n !== 'number') return '—'
      if (n < 1024) return n + ' B'
      if (n < 1048576) return (n / 1024).toFixed(0) + ' KB'
      return (n / 1048576).toFixed(1) + ' MB'
    }
    function fmtTime(ms) {
      if (!ms) return '—'
      const d = new Date(ms)
      const diff = Date.now() - ms
      if (diff < 60e3) return '刚刚'
      if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前'
      if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前'
      if (diff < 2 * 86400e3) return '昨天'
      if (diff < 7 * 86400e3) return Math.floor(diff / 86400e3) + ' 天前'
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    }

    /* ── 极简 Markdown 渲染（转义后逐行解析）── */
    function escHtml(s) {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    }
    function mdToHtml(src) {
      const lines = escHtml(src).split('\n')
      let out = ''
      let inCode = false
      let listType = null
      let i = 0
      const closeList = () => {
        if (listType) { out += listType === 'ul' ? '</ul>' : '</ol>'; listType = null }
      }
      const inline = (s) => s
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
      const cells = (row) => {
        const s = row.trim().replace(/^\|/, '').replace(/\|$/, '')
        return s.split('|').map(c => c.trim())
      }
      while (i < lines.length) {
        const t = lines[i].trim()
        if (/^```/.test(t)) {
          closeList()
          out += inCode ? '</code></pre>' : '<pre><code>'
          inCode = !inCode
          i++
          continue
        }
        if (inCode) { out += lines[i] + '\n'; i++; continue }
        if (t === '') { closeList(); i++; continue }
        const hd = t.match(/^(#{1,6})\s+(.*)$/)
        if (hd) {
          closeList()
          out += '<h' + hd[1].length + ' id="toc-' + i + '">' + inline(hd[2]) + '</h' + hd[1].length + '>'
          i++
          continue
        }
        if (/^[-*]\s+/.test(t)) {
          if (listType !== 'ul') { closeList(); out += '<ul>'; listType = 'ul' }
          out += '<li>' + inline(t.replace(/^[-*]\s+/, '')) + '</li>'
          i++
          continue
        }
        if (/^\d+\.\s+/.test(t)) {
          if (listType !== 'ol') { closeList(); out += '<ol>'; listType = 'ol' }
          out += '<li>' + inline(t.replace(/^\d+\.\s+/, '')) + '</li>'
          i++
          continue
        }
        if (/^\|.+\|$/.test(t) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1].trim())) {
          closeList()
          out += '<table><thead><tr>' + cells(t).map(c => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>'
          i += 2
          while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i].trim())) {
            out += '<tr>' + cells(lines[i].trim()).map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>'
            i++
          }
          out += '</tbody></table>'
          continue
        }
        if (/^>\s?/.test(t)) {
          closeList()
          out += '<blockquote>' + inline(t.replace(/^>\s?/, '')) + '</blockquote>'
          i++
          continue
        }
        out += '<p>' + inline(t) + '</p>'
        i++
      }
      if (inCode) out += '</code></pre>'
      closeList()
      return out
    }
    function mdToc(src) {
      return src.split('\n')
        .map((line, idx) => {
          const m = line.trim().match(/^(#{1,6})\s+(.*)$/)
          return m ? { idx, level: m[1].length, text: m[2].replace(/[#\s]+$/, '') } : null
        })
        .filter(Boolean)
    }

    /* ── 侧栏图标 ── */
    const PanelIcon = () =>
      h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8 },
        h('path', { d: 'M4 4h9a3 3 0 0 1 3 3v13H7a3 3 0 0 1-3-3V4z' }),
        h('path', { d: 'M16 7l4-2v13a2 2 0 0 1-2 2h-2' }),
        h('path', { d: 'M7 8h5M7 11h5M7 14h3' }))

    /* ── 主面板：左侧菜单（新建/最近使用/本地产物/我的资料）+ 右侧内容区 ── */
    function LibraryPage() {
      const [section, setSection] = useState('files')    // recent | files | pending
      const [overlay, setOverlay] = useState(false)      // 本地产物弹层（覆盖整页）
      const [tree, setTree] = useState([])
      const [pending, setPending] = useState([])
      const [pins, setPins] = useState([])
      const [artifacts, setArtifacts] = useState([])
      const [cwd, setCwd] = useState('')
      const [file, setFile] = useState(null)             // 内容区打开的文件
      const [openPending, setOpenPending] = useState(null)
      const [drawer, setDrawer] = useState(null)         // 弹层右侧抽屉 { path, kind, text }
      const [title, setTitle] = useState('')
      const [draft, setDraft] = useState('')
      const [saveState, setSaveState] = useState('')
      const [msg, setMsg] = useState('')
      const [query, setQuery] = useState('')
      const [searchHits, setSearchHits] = useState(null)
      const [oQuery, setOQuery] = useState('')           // 弹层筛选词
      const [oType, setOType] = useState('all')          // 弹层类型筛选
      const [favorites, setFavorites] = useState(() => loadSet('wbdesk-fav'))
      const [favOnly, setFavOnly] = useState(false)
      const [typeFilter, setTypeFilter] = useState('all')
      const [sort, setSort] = useState({ key: 'name', dir: 1 })
      const [selected, setSelected] = useState(new Set())
      const [openGroups, setOpenGroups] = useState(new Set())
      const [recents, setRecents] = useState(() => {
        try { return JSON.parse(localStorage.getItem('wbdesk-recent') || '[]') } catch { return [] }
      })
      const [showNew, setShowNew] = useState(false)
      const [showLink, setShowLink] = useState(false)
      const [linkForm, setLinkForm] = useState({ name: '', url: '' })
      const [showCloud, setShowCloud] = useState(false)
      const [cloudCfg, setCloudCfg] = useState({ protocol: 'cos', endpoint: '', bucket: '', prefix: 'dsh-library', region: '', accessKey: '', secretKey: '', autoPush: true })
      const [cloudHasSaved, setCloudHasSaved] = useState(false)
      const [cloudStatus, setCloudStatus] = useState('')
      const [cloudBusy, setCloudBusy] = useState(false)
      const uploadInput = useRef(null)
      const importInput = useRef(null)
      const [showFilter, setShowFilter] = useState(false)
      const [showOFilter, setShowOFilter] = useState(false)
      const [menu, setMenu] = useState(null)             // { x, y, node, kind }
      const [confirmDel, setConfirmDel] = useState(false)
      const [renaming, setRenaming] = useState(null)
      const [showToc, setShowToc] = useState(false)
      const saveTimer = useRef(null)
      const msgTimer = useRef(null)

      const say = (text) => {
        setMsg(text)
        if (msgTimer.current) clearTimeout(msgTimer.current)
        msgTimer.current = setTimeout(() => setMsg(''), 3200)
      }

      const refresh = useCallback(() => {
        api('/tree').then(b => setTree(b.items || [])).catch(() => {})
        api('/pending').then(b => setPending(b.items || [])).catch(() => {})
        api('/pins').then(b => setPins(b.items || [])).catch(() => {})
        api('/artifacts').then(b => setArtifacts(b.items || [])).catch(() => {})
      }, [])
      useEffect(() => { refresh() }, [refresh])

      useEffect(() => {
        if (query.trim() === '') { setSearchHits(null); return }
        const t = setTimeout(() => {
          api('/search?q=' + encodeURIComponent(query.trim()))
            .then(b => setSearchHits(b.hits || []))
            .catch(() => {})
        }, 300)
        return () => clearTimeout(t)
      }, [query])

      /* 树工具 */
      const findNode = useCallback((path) => {
        if (!path) return { children: tree, kind: 'directory', path: '', name: '' }
        const parts = path.split('/')
        let list = tree
        let node = null
        for (const part of parts) {
          node = (list || []).find(n => n.name === part)
          if (!node) return null
          list = node.children
        }
        return node
      }, [tree])
      const allDirs = useMemo(() => {
        const out = []
        const walk = (nodes, depth) => (nodes || []).forEach(n => {
          if (n.kind !== 'directory') return
          out.push({ path: n.path, name: n.name, depth })
          walk(n.children, depth + 1)
        })
        walk(tree, 0)
        return out
      }, [tree])
      /* 路径 → 大小/时间（产物/最近列表的大小列从树上查） */
      const treeMeta = useMemo(() => {
        const m = {}
        const walk = (nodes) => (nodes || []).forEach(n => {
          m[n.path] = { size: n.size, mtime: n.mtime }
          walk(n.children)
        })
        walk(tree)
        return m
      }, [tree])
      const pinnedMap = useMemo(() => {
        const m = {}
        for (const p of pins) m[p.relPath] = p
        return m
      }, [pins])

      const pushRecent = (path) => setRecents(prev => {
        const list = [path, ...prev.filter(p => p !== path)].slice(0, 8)
        try { localStorage.setItem('wbdesk-recent', JSON.stringify(list)) } catch { /* 隐私模式就算了 */ }
        return list
      })

      /* 打开文件（内容区详情页） */
      const openFile = useCallback((path) => {
        setOpenPending(null)
        setFile({ path, kind: 'loading', text: null })
        setDraft('')
        setTitle('')
        setSaveState('')
        pushRecent(path)
        api('/file?path=' + encodeURIComponent(path))
          .then(b => {
            setFile(b)
            if (b.kind === 'text') setDraft(b.text || '')
          })
          .catch(() => setFile({ path, kind: 'error', text: null }))
      }, [])

      /* 弹层抽屉（只读预览） */
      const openDrawer = useCallback((path) => {
        setDrawer({ path, kind: 'loading', text: null })
        api('/file?path=' + encodeURIComponent(path))
          .then(b => setDrawer(b))
          .catch(() => setDrawer({ path, kind: 'error', text: null }))
      }, [])

      const closeDetail = () => {
        setFile(null)
        setOpenPending(null)
        setDraft('')
        setShowToc(false)
      }

      /* 节点操作 */
      const toggleFav = (path) => {
        setFavorites(prev => {
          const next = new Set(prev)
          next.has(path) ? next.delete(path) : next.add(path)
          saveSet('wbdesk-fav', next)
          return next
        })
      }
      const copyText = (text, tip) => {
        if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {})
        say(tip)
      }
      const startRename = (node) => {
        setMenu(null)
        setRenaming({ path: node.path, value: node.name.replace(/\.[a-z0-9]+$/i, '') })
      }
      const commitRename = async (node) => {
        if (!renaming || renaming.path !== node.path) return
        const stem = renaming.value.trim()
        setRenaming(null)
        const ext = node.name.slice(node.name.lastIndexOf('.'))
        const newName = stem + (node.kind === 'file' && ext ? ext : '')
        if (!stem || newName === node.name) return
        try {
          const b = await post('/rename', { path: node.path, name: newName })
          refresh()
          if (file && file.path === node.path && b.path) setFile(f => f && { ...f, path: b.path })
          say('已重命名')
        } catch (e) { say('重命名失败：' + e.message) }
      }
      const commitTitle = async () => {
        if (!file) return
        const stem = title.trim()
        const oldName = file.path.split('/').pop()
        const ext = oldName.slice(oldName.lastIndexOf('.'))
        const newName = stem + ext
        if (!stem || newName === oldName) { setTitle(''); return }
        try {
          const b = await post('/rename', { path: file.path, name: newName })
          refresh()
          if (b.path) setFile(f => f && { ...f, path: b.path })
        } catch (e) { say('重命名失败：' + e.message) }
      }
      const deleteNode = async (node) => {
        setMenu(null)
        setConfirmDel(false)
        try {
          await post('/delete', { path: node.path })
          refresh()
          if (file && file.path === node.path) closeDetail()
          if (drawer && drawer.path === node.path) setDrawer(null)
          say('已移入回收站')
        } catch (e) { say('删除失败：' + e.message) }
      }
      const moveNode = async (node, targetDir) => {
        setMenu(null)
        try {
          const b = await post('/move', { path: node.path, targetDir })
          refresh()
          if (file && file.path === node.path && b.path) setFile(f => f && { ...f, path: b.path })
          say('已移动到 ' + (targetDir || '库根'))
        } catch (e) { say('移动失败：' + e.message) }
      }
      const createNew = async (type) => {
        setShowNew(false)
        const dir = cwd || 'inbox'
        try {
          if (type === 'dir') {
            await post('/mkdir', { path: dir + '/未命名文件夹' })
            refresh()
            return
          }
          const b = await post('/newfile', { dir, type })
          await refresh()
          const isOffice = type === 'docx' || type === 'xlsx' || type === 'pptx'
          if (isOffice) {
            // Office 文件不在面板内编辑：选中并进入改名，双击可系统打开
            setSection('files')
            setCwd(dir)
            setRenaming({ path: b.path, value: b.path.split('/').pop().replace(/\.[a-z0-9]+$/i, '') })
          } else {
            setSection('files')
            openFile(b.path)
            setRenaming({ path: b.path, value: b.path.split('/').pop().replace(/\.[a-z0-9]+$/i, '') })
          }
        } catch (e) { say('新建失败：' + e.message) }
      }
      /* 上传 / 导入：读文件转 base64 落盘到当前目录 */
      const fileToBase64 = (f) => new Promise((resolvePromise, rejectPromise) => {
        const reader = new FileReader()
        reader.onload = () => resolvePromise(String(reader.result).split(',')[1] || '')
        reader.onerror = () => rejectPromise(reader.error)
        reader.readAsDataURL(f)
      })
      const uploadFiles = async (fileList, keepStructure) => {
        const files = [...fileList]
        if (files.length === 0) return
        const dir = cwd || 'inbox'
        say('正在上传 ' + files.length + ' 个文件…')
        let ok = 0
        let failed = 0
        for (const f of files) {
          try {
            const base64 = await fileToBase64(f)
            const name = keepStructure && f.webkitRelativePath ? f.webkitRelativePath.replace(/^[^/]+\//, '') : f.name
            await post('/upload', { dir, name, base64 })
            ok++
          } catch { failed++ }
        }
        refresh()
        say(failed ? '已上传 ' + ok + ' 个，失败 ' + failed + ' 个' : '已上传 ' + ok + ' 个文件')
      }
      const addLink = async () => {
        const name = linkForm.name.trim()
        const url = linkForm.url.trim()
        if (!name || !url) { say('名称和链接都要填'); return }
        setShowLink(false)
        const content = '# ' + name + '\n\n[' + url + '](' + url + ')\n'
        try {
          await post('/upload', { dir: cwd || 'inbox', name: name.replace(/[\\/:*?"<>|]/g, '_') + '.md', base64: btoa(unescape(encodeURIComponent(content))) })
          refresh()
          say('链接已保存为文档')
        } catch (e) { say('添加失败：' + e.message) }
      }

      /* ── 云同步 ── */
      const openCloud = async () => {
        setShowCloud(true)
        setCloudStatus('')
        try {
          const b = await api('/cloud/config')
          if (b.configured && b.config) {
            setCloudCfg(c => ({ ...c, ...b.config, secretKey: '' }))
            setCloudHasSaved(true)
          }
        } catch { /* 未配置过 */ }
      }
      const saveCloud = async () => {
        setCloudBusy(true)
        try {
          await post('/cloud/config', { ...cloudCfg, secretKey: cloudCfg.secretKey || '__keep__' })
          setCloudHasSaved(true)
          say('云同步配置已保存')
        } catch (e) { say('保存失败：' + e.message) }
        finally { setCloudBusy(false) }
      }
      const testCloudConn = async () => {
        setCloudBusy(true)
        setCloudStatus('正在测试…')
        try {
          if (!cloudHasSaved || cloudCfg.secretKey) await post('/cloud/config', { ...cloudCfg, secretKey: cloudCfg.secretKey || '__keep__' })
          const b = await post('/cloud/test', {})
          setCloudStatus(b.ok ? b.detail : '失败：' + b.detail)
        } catch (e) { setCloudStatus('失败：' + e.message) }
        finally { setCloudBusy(false) }
      }
      const syncCloudNow = async () => {
        setCloudBusy(true)
        setCloudStatus('正在同步…')
        try {
          const b = await post('/cloud/sync', {})
          const err = (b.errors || []).length
          setCloudStatus('上传 ' + b.pushed + ' · 下载 ' + b.pulled + ' · 跳过 ' + b.skipped + (err ? ' · 失败 ' + err : ''))
          refresh()
        } catch (e) { setCloudStatus('同步失败：' + e.message) }
        finally { setCloudBusy(false) }
      }
      const resolvePending = async (id, action) => {
        try {
          const b = await post('/pending/resolve', { id, action })
          setPending(b.items || [])
          refresh()
          setOpenPending(null)
          say(action === 'accept' ? '已接受并写入原文件' : '已拒绝（内容留档可找回）')
        } catch (e) { say('操作失败：' + e.message) }
      }
      const releasePin = async (relPath) => {
        setMenu(null)
        try {
          const b = await post('/pins/release', { path: relPath })
          setPins(b.items || [])
          say('已释放固定引用')
        } catch (e) { say('操作失败：' + e.message) }
      }
      const openMenu = (e, node, kind) => {
        e.stopPropagation()
        e.preventDefault()
        setConfirmDel(false)
        setMenu({ x: e.clientX, y: e.clientY, node, kind })
      }
      const toggleSelect = (path) => {
        setSelected(prev => {
          const next = new Set(prev)
          next.has(path) ? next.delete(path) : next.add(path)
          return next
        })
      }
      const toggleGroup = (key) => setOpenGroups(prev => {
        const next = new Set(prev)
        next.has(key) ? next.delete(key) : next.add(key)
        return next
      })

      /* ── 行：复选列 / 名称列 ── */
      const checkCol = (path) => h('span', {
        className: 'wb-checkcol',
        onClick: e => { e.stopPropagation(); toggleSelect(path) },
      }, h('span', { className: 'wb-checkbox' + (selected.has(path) ? ' on' : '') },
        selected.has(path) && Icon.check(11)))

      const nameCol = (node) => {
        const isDir = node.kind === 'directory'
        const editing = renaming && renaming.path === node.path
        const pin = pinnedMap[node.path]
        return h('div', { className: 'wb-col-name' },
          isDir ? Icon.folder(20) : fileIcon(node.name, 20),
          editing
            ? h('input', {
                className: 'wb-rename',
                value: renaming.value,
                autoFocus: true,
                onClick: e => e.stopPropagation(),
                onChange: e => setRenaming({ path: node.path, value: e.target.value }),
                onKeyDown: e => {
                  if (e.key === 'Enter') commitRename(node)
                  if (e.key === 'Escape') setRenaming(null)
                },
                onBlur: () => commitRename(node),
              })
            : h('span', { className: 'wb-filename clickable' }, node.name),
          favorites.has(node.path) && h('span', { className: 'wb-star' }, Icon.star(12, true)),
          pin && h('span', {
            className: 'wb-pin' + (pin.drifted ? ' drifted' : ''),
            title: pin.drifted ? '固定引用的文件已变化' : '已被固定引用',
          }, Icon.pin(12)),
          !isDir && h('span', {
            className: 'wb-spark', title: '复制 @ 引用路径',
            onClick: e => { e.stopPropagation(); copyText('@' + node.path, '已复制 @ 引用路径') },
          }, Icon.plus(14)))
      }

      /* ── ⋯ 浮层菜单 ── */
      const renderMenu = () => {
        if (!menu) return null
        const node = menu.node
        const isDir = node.kind === 'directory'
        const item = (label, onClick, danger) => h('div', {
          key: label,
          className: 'wb-menu-item' + (danger ? ' danger' : ''),
          onClick: e => { e.stopPropagation(); onClick() },
        }, label)
        return h(React.Fragment, null,
          h('div', { className: 'wb-menu-mask', onClick: () => setMenu(null), onContextMenu: e => { e.preventDefault(); setMenu(null) } }),
          h('div', {
            className: 'wb-menu',
            style: { left: Math.min(menu.x, window.innerWidth - 200), top: Math.min(menu.y, window.innerHeight - 300) },
          },
            menu.kind === 'pending'
              ? [
                  item('查看内容', () => { setOpenPending(node); setMenu(null) }),
                  item('接受写入', () => resolvePending(node.id, 'accept')),
                  item('拒绝', () => resolvePending(node.id, 'reject'), true),
                ]
              : [
                  !isDir && item('打开', () => { setMenu(null); overlay ? openDrawer(node.path) : openFile(node.path) }),
                  isDir && item('打开文件夹', () => { setCwd(node.path); setSection('files'); setMenu(null) }),
                  item('重命名', () => startRename(node)),
                  item('复制路径', () => { copyText(node.path, '路径已复制'); setMenu(null) }),
                  item(favorites.has(node.path) ? '取消收藏' : '收藏', () => { toggleFav(node.path); setMenu(null) }),
                  pinnedMap[node.path] && item('释放固定引用', () => releasePin(node.path)),
                  h('div', { key: 'sep1', className: 'wb-menu-sep' }),
                  h('div', { key: 'moveto', className: 'wb-menu-sub' },
                    h('div', { className: 'wb-menu-item has-sub' }, '移动到', Icon.chevron(13)),
                    h('div', { className: 'wb-submenu' },
                      [{ path: '', name: '库根目录', depth: 0 }, ...allDirs]
                        .filter(d => d.path !== node.path && !d.path.startsWith(node.path + '/'))
                        .map(d => h('div', {
                          key: d.path || '$root', className: 'wb-menu-item',
                          style: { paddingLeft: 14 + d.depth * 12 },
                          onClick: e => { e.stopPropagation(); moveNode(node, d.path) },
                        }, d.path === '' ? '库根目录' : d.name)))),
                  h('div', { key: 'sep2', className: 'wb-menu-sep' }),
                  confirmDel
                    ? h('div', { key: 'confirm', className: 'wb-menu-item danger', onClick: e => { e.stopPropagation(); deleteNode(node) } }, '确认删除？')
                    : item('删除', () => setConfirmDel(true), true),
                ]))
      }

      /* ── 表头 ── */
      const listHeader = (cols) => h('div', { className: 'wb-list-header' },
        h('span', { className: 'wb-checkcol' }),
        cols.map(c => h('span', {
          key: c.label,
          className: 'wb-col ' + (c.cls || '') + (c.sortKey ? ' sortable' : '') + (sort.key === c.sortKey ? ' is-sorted' : ''),
          onClick: c.sortKey ? () => setSort(s => ({ key: c.sortKey, dir: s.key === c.sortKey ? -s.dir : 1 })) : undefined,
        }, c.label, sort.key === c.sortKey && h('span', { className: 'wb-sort-arrow' }, sort.dir === 1 ? '↑' : '↓'))),
        h('span', { className: 'wb-col-actions' }))

      /* ── 我的资料：当前目录行 ── */
      const fileRows = () => {
        const node = findNode(cwd)
        let rows = (node && node.children) || []
        if (typeFilter !== 'all') {
          rows = rows.filter(n => typeFilter === 'dir' ? n.kind === 'directory' : n.kind === 'file' && typeOf(n.name) === typeFilter)
        }
        if (favOnly) rows = rows.filter(n => favorites.has(n.path))
        const dirCmp = (a, b) => a.kind === b.kind ? 0 : a.kind === 'directory' ? -1 : 1
        rows = [...rows].sort((a, b) => {
          const d = dirCmp(a, b)
          if (d !== 0) return d
          if (sort.key === 'time') return ((a.mtime || 0) - (b.mtime || 0)) * sort.dir
          return a.name.localeCompare(b.name, 'zh') * sort.dir
        })
        if (rows.length === 0) {
          return h('div', { className: 'wb-empty' },
            h('div', { className: 'wb-empty-icon' }, Icon.inbox(40)),
            h('div', null, favOnly ? '这个文件夹里还没有收藏' : '这个文件夹还是空的'),
            h('div', { className: 'wb-empty-sub' }, '点左侧「＋ 新建」，或让 Agent 生成文件自动归位到 inbox/'))
        }
        return rows.map(node => {
          const isDir = node.kind === 'directory'
          const isOpen = file && file.path === node.path
          return h('div', {
            key: node.path,
            className: 'wb-row' + (selected.has(node.path) ? ' is-selected' : '') + (isOpen ? ' is-open' : ''),
            onClick: () => isDir ? setCwd(node.path) : openFile(node.path),
            onContextMenu: e => openMenu(e, node, 'node'),
          },
            checkCol(node.path),
            nameCol(node),
            h('span', { className: 'wb-col wb-col-type' }, isDir ? '文件夹' : typeLabel(node.name)),
            h('span', { className: 'wb-col wb-col-author' }, isDir ? '' : '我'),
            h('span', { className: 'wb-col wb-col-time' }, fmtTime(node.mtime)),
            h('span', { className: 'wb-col wb-col-size' }, isDir ? '—' : fmtSize(node.size)),
            h('span', { className: 'wb-col-actions' },
              h('span', { className: 'wb-icon-btn', onClick: e => openMenu(e, node, 'node') }, Icon.more(16))))
        })
      }

      /* ── 最近使用 ── */
      const recentRows = () => {
        const rows = recents.filter(p => treeMeta[p])
        if (rows.length === 0) {
          return h('div', { className: 'wb-empty' },
            h('div', { className: 'wb-empty-icon' }, Icon.clock(40)),
            h('div', null, '最近还没有打开过文件'),
            h('div', { className: 'wb-empty-sub' }, '打开过的文件会列在这里，方便快速回来'))
        }
        return rows.map(p => {
          const name = p.split('/').pop()
          const node = { path: p, name, kind: 'file' }
          const meta = treeMeta[p] || {}
          return h('div', {
            key: p,
            className: 'wb-row' + (selected.has(p) ? ' is-selected' : ''),
            onClick: () => openFile(p),
            onContextMenu: e => openMenu(e, node, 'node'),
          },
            checkCol(p),
            h('div', { className: 'wb-col-name' },
              fileIcon(name, 20),
              h('span', { className: 'wb-filename clickable' }, name),
              h('span', { className: 'wb-subpath' }, p),
              favorites.has(p) && h('span', { className: 'wb-star' }, Icon.star(12, true)),
              pinnedMap[p] && h('span', { className: 'wb-pin' + (pinnedMap[p].drifted ? ' drifted' : '') }, Icon.pin(12))),
            h('span', { className: 'wb-col wb-col-type' }, typeLabel(name)),
            h('span', { className: 'wb-col wb-col-author' }, '我'),
            h('span', { className: 'wb-col wb-col-time' }, fmtTime(meta.mtime)),
            h('span', { className: 'wb-col wb-col-size' }, fmtSize(meta.size)),
            h('span', { className: 'wb-col-actions' },
              h('span', { className: 'wb-icon-btn', onClick: e => openMenu(e, node, 'node') }, Icon.more(16))))
        })
      }

      /* ── 待确认 ── */
      const pendingRows = () => {
        if (pending.length === 0) {
          return h('div', { className: 'wb-empty' },
            h('div', { className: 'wb-empty-icon' }, Icon.check(40)),
            h('div', null, '没有待确认的修改'),
            h('div', { className: 'wb-empty-sub' }, 'Agent 修改库内已有文件时，会先列在这里等你确认'))
        }
        return pending.map(p => {
          const name = (p.targetPath || '').split(/[\\/]/).pop()
          return h('div', {
            key: p.id,
            className: 'wb-row',
            onClick: () => setOpenPending(p),
            onContextMenu: e => openMenu(e, p, 'pending'),
          },
            h('span', { className: 'wb-checkcol' }),
            h('span', { className: 'wb-col-name' },
              fileIcon(name || 'x.md', 20),
              h('span', { className: 'wb-filename clickable' }, name),
              h('span', { className: 'wb-tag warn' }, p.tool === 'edit' ? '修改' : '覆盖')),
            h('span', { className: 'wb-col wb-col-type' }, typeLabel(name || '')),
            h('span', { className: 'wb-col wb-col-author' }, 'Agent'),
            h('span', { className: 'wb-col wb-col-time' }, fmtTime(Date.parse(p.createdAt) || 0)),
            h('span', { className: 'wb-col wb-col-size' }),
            h('span', { className: 'wb-col-actions wb-row-actions-visible' },
              h('button', { className: 'wb-mini-btn ok', onClick: e => { e.stopPropagation(); resolvePending(p.id, 'accept') } }, '接受'),
              h('button', { className: 'wb-mini-btn', onClick: e => { e.stopPropagation(); resolvePending(p.id, 'reject') } }, '拒绝')))
        })
      }

      /* ── 搜索结果 ── */
      const searchRows = () => {
        if (!searchHits || searchHits.length === 0) {
          return h('div', { className: 'wb-empty' }, h('div', null, '没有匹配的内容'))
        }
        return searchHits.map((hit, i) => h('div', {
          key: i,
          className: 'wb-row',
          onClick: () => openFile(hit.path),
        },
          h('span', { className: 'wb-checkcol' }),
          h('span', { className: 'wb-col-name', style: { flexDirection: 'column', alignItems: 'flex-start', gap: 2 } },
            h('span', { className: 'wb-filename clickable' }, hit.path + ':' + hit.lineNo),
            h('span', { className: 'wb-hit-line' }, hit.line)),
          h('span', { className: 'wb-col-actions' })))
      }

      /* ── 本地产物弹层：按工作区 → 会话分组 ── */
      const artifactGroups = useMemo(() => {
        let items = artifacts
        if (oType !== 'all') items = items.filter(a => typeOf(a.libPath) === oType)
        if (oQuery.trim()) {
          const q = oQuery.trim().toLowerCase()
          items = items.filter(a => a.libPath.toLowerCase().includes(q) || (a.sessionId || '').toLowerCase().includes(q))
        }
        const byWs = {}
        for (const a of items) {
          const ws = a.sourcePath
            ? (a.sourcePath.replace(/\\/g, '/').split('/').filter(Boolean).slice(-2, -1)[0] || a.sourcePath)
            : '库内产出'
          const sid = a.sessionId || '未知会话'
          if (!byWs[ws]) byWs[ws] = { ws, sessions: {}, latest: '' }
          if (!byWs[ws].sessions[sid]) byWs[ws].sessions[sid] = { sid, items: [], latest: '' }
          byWs[ws].sessions[sid].items.push(a)
          if (a.time > byWs[ws].sessions[sid].latest) byWs[ws].sessions[sid].latest = a.time
          if (a.time > byWs[ws].latest) byWs[ws].latest = a.time
        }
        return Object.values(byWs)
          .map(g => ({ ...g, sessions: Object.values(g.sessions).sort((a, b) => b.latest.localeCompare(a.latest)) }))
          .sort((a, b) => b.latest.localeCompare(a.latest))
      }, [artifacts, oQuery, oType])

      const renderOverlay = () => {
        if (!overlay) return null
        const filterLabel = { all: '全部类型', doc: '文档', sheet: '表格', web: '网页', other: '其他' }[oType]
        return h('div', { className: 'wb-overlay' },
          /* 顶栏：左上角返回资料库 */
          h('div', { className: 'wb-overlay-top' },
            h('span', { className: 'wb-back-link', onClick: () => { setOverlay(false); setDrawer(null) } },
              Icon.back(15), '返回资料库'),
            h('span', { className: 'wb-overlay-title' }, '本地产物')),
          /* 筛选区 */
          h('div', { className: 'wb-toolbar' },
            h('div', { className: 'wb-toolbar-left' },
              h('div', { className: 'wb-search' },
                Icon.search(14),
                h('input', {
                  value: oQuery,
                  onChange: e => setOQuery(e.target.value),
                  placeholder: '搜索产物名或会话…',
                }),
                oQuery && h('span', { className: 'wb-search-clear', onClick: () => setOQuery('') }, Icon.x(12))),
              h('div', { className: 'wb-filter' },
                h('button', {
                  type: 'button',
                  className: 'wb-filter-btn' + (oType !== 'all' ? ' on' : ''),
                  onClick: () => setShowOFilter(v => !v),
                }, filterLabel, h('span', { className: 'wb-chevron down' }, Icon.chevron(12))),
                showOFilter && h(React.Fragment, null,
                  h('div', { className: 'wb-menu-mask', onClick: () => setShowOFilter(false) }),
                  h('div', { className: 'wb-filter-menu' },
                    [['all', '全部类型'], ['doc', '文档'], ['sheet', '表格'], ['web', '网页'], ['other', '其他']]
                      .map(([v, label]) => h('div', {
                        key: v,
                        className: 'wb-menu-item' + (oType === v ? ' active' : ''),
                        onClick: () => { setOType(v); setShowOFilter(false) },
                      }, label))))))),
          /* 表头 + 分组列表 */
          h('div', { className: 'wb-body' },
            listHeader([
              { label: '名称', cls: 'wb-col-name-h' },
              { label: '类型', cls: 'wb-col-type' },
              { label: '更新人', cls: 'wb-col-author' },
              { label: '更新时间', cls: 'wb-col-time' },
              { label: '大小', cls: 'wb-col-size' },
            ]),
            h('div', { className: 'wb-list' },
              artifactGroups.length === 0
                ? h('div', { className: 'wb-empty' },
                    h('div', { className: 'wb-empty-icon' }, Icon.robot(40)),
                    h('div', null, artifacts.length === 0 ? '还没有任务产物' : '没有匹配的产物'),
                    h('div', { className: 'wb-empty-sub' }, 'Agent 在对话里新建的文件会自动归位到资料库，并按会话列在这里'))
                : artifactGroups.map(g => {
                    const wsOpen = openGroups.has('ws:' + g.ws)
                    const wsCount = g.sessions.reduce((n, s) => n + s.items.length, 0)
                    return h('div', { key: g.ws },
                      h('div', { className: 'wb-row wb-row-group', onClick: () => toggleGroup('ws:' + g.ws) },
                        h('span', { className: 'wb-chevron' + (wsOpen ? ' open' : '') }, Icon.chevron(14)),
                        h('span', { className: 'wb-col-name' },
                          Icon.folder(20),
                          h('span', { className: 'wb-taskname' }, g.ws),
                          h('span', { className: 'wb-pill' }, wsCount + ' 个产物')),
                        h('span', { className: 'wb-col wb-col-type' }),
                        h('span', { className: 'wb-col wb-col-author' }),
                        h('span', { className: 'wb-col wb-col-time' }, fmtTime(Date.parse(g.latest) || 0)),
                        h('span', { className: 'wb-col wb-col-size' }),
                        h('span', { className: 'wb-col-actions' })),
                      wsOpen && g.sessions.map(s => {
                        const sOpen = openGroups.has('s:' + g.ws + ' ' + s.sid)
                        return h('div', { key: s.sid },
                          h('div', { className: 'wb-row wb-row-l1', onClick: () => toggleGroup('s:' + g.ws + ' ' + s.sid) },
                            h('span', { className: 'wb-chevron' + (sOpen ? ' open' : '') }, Icon.chevron(14)),
                            h('span', { className: 'wb-col-name' },
                              Icon.robot(18),
                              h('span', { className: 'wb-filename' }, '会话 ' + s.sid),
                              h('span', { className: 'wb-pill' }, s.items.length + ' 个产物')),
                            h('span', { className: 'wb-col wb-col-type' }),
                            h('span', { className: 'wb-col wb-col-author' }),
                            h('span', { className: 'wb-col wb-col-time' }, fmtTime(Date.parse(s.latest) || 0)),
                            h('span', { className: 'wb-col wb-col-size' }),
                            h('span', { className: 'wb-col-actions' })),
                          sOpen && s.items.map((a, i) => {
                            const name = a.libPath.split('/').pop()
                            const node = { path: a.libPath, name, kind: 'file' }
                            const meta = treeMeta[a.libPath] || {}
                            return h('div', {
                              key: s.sid + ' ' + i,
                              className: 'wb-row wb-row-l2' + (drawer && drawer.path === a.libPath ? ' is-open' : ''),
                              onClick: () => openDrawer(a.libPath),
                              onContextMenu: e => openMenu(e, node, 'node'),
                            },
                              h('span', { className: 'wb-checkcol' }),
                              h('span', { className: 'wb-col-name' },
                                fileIcon(name, 20),
                                h('span', { className: 'wb-filename clickable' }, name),
                                h('span', { className: 'wb-tag' + (a.kind === 'pending' ? ' warn' : '') }, a.kind === 'pending' ? '待确认' : '已归位')),
                              h('span', { className: 'wb-col wb-col-type' }, typeLabel(name)),
                              h('span', { className: 'wb-col wb-col-author' }, 'Agent'),
                              h('span', { className: 'wb-col wb-col-time' }, fmtTime(Date.parse(a.time) || 0)),
                              h('span', { className: 'wb-col wb-col-size' }, fmtSize(meta.size)),
                              h('span', { className: 'wb-col-actions' },
                                h('span', { className: 'wb-icon-btn', onClick: e => openMenu(e, node, 'node') }, Icon.more(16))))
                          }))
                      }))
                  }))),
          renderDrawer())
      }

      /* ── 右侧抽屉（只读预览） ── */
      const renderDrawer = () => {
        if (!drawer) return null
        const name = drawer.path.split('/').pop()
        const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
        let body
        if (drawer.kind === 'loading') body = h('div', { className: 'wb-hint' }, '加载中…')
        else if (drawer.kind === 'error') body = h('div', { className: 'wb-hint' }, '读取失败')
        else if (drawer.kind === 'binary') body = h('div', { className: 'wb-hint' }, '这个文件是二进制格式，暂不支持预览')
        else if (drawer.kind === 'too-large') body = h('div', { className: 'wb-hint' }, '文件过大，暂不支持预览')
        else if (ext === '.html' || ext === '.htm') body = h('iframe', { srcDoc: drawer.text, sandbox: 'allow-scripts', title: name, className: 'wb-html-frame' })
        else if (ext === '.csv') body = h('div', { className: 'wb-csv' },
          h('table', null,
            (drawer.text || '').split('\n').filter(r => r.trim() !== '').map((row, ri) => h('tr', { key: ri },
              row.split(',').map((cell, ci) => h(ri === 0 ? 'th' : 'td', { key: ci }, cell))))))
        else if (ext === '.md') body = h('div', { className: 'wb-md wb-md-body', dangerouslySetInnerHTML: { __html: mdToHtml(drawer.text || '') } })
        else body = h('pre', { className: 'wb-pre' }, drawer.text || '')
        return h('div', { className: 'wb-drawer' },
          h('div', { className: 'wb-drawer-head' },
            fileIcon(name, 18),
            h('span', { className: 'wb-drawer-title', title: drawer.path }, name),
            h('span', { style: { flex: 1 } }),
            h('span', { className: 'wb-icon-btn', title: '在资料库中打开', onClick: () => { setOverlay(false); setDrawer(null); openFile(drawer.path) } }, Icon.doc(15)),
            h('span', { className: 'wb-icon-btn', title: '关闭', onClick: () => setDrawer(null) }, Icon.x(15))),
          h('div', { className: 'wb-drawer-path' }, drawer.path),
          h('div', { className: 'wb-drawer-body' }, body))
      }

      /* ── 详情页（内容区）：返回 + 面包屑 + 大标题 + 正文 ── */
      const renderDetail = () => {
        if (openPending) {
          const p = openPending
          const name = (p.targetPath || '').split(/[\\/]/).pop()
          return h('div', { className: 'wb-detail' },
            h('div', { className: 'wb-detail-bar' },
              h('span', { className: 'wb-icon-btn', onClick: () => setOpenPending(null), title: '返回' }, Icon.back(16)),
              h('span', { className: 'wb-crumb' }, '待确认', ' / ', name),
              h('span', { style: { flex: 1 } }),
              h('button', { className: 'wb-mini-btn', onClick: () => resolvePending(p.id, 'reject') }, '拒绝'),
              h('button', { className: 'wb-mini-btn ok', onClick: () => resolvePending(p.id, 'accept') }, '接受写入')),
            h('div', { className: 'wb-detail-title-row' },
              h('span', { className: 'wb-detail-title' }, name),
              h('span', { className: 'wb-tag warn' }, (p.tool === 'edit' ? '修改' : '覆盖') + ' · 待确认')),
            h('div', { className: 'wb-detail-body wb-md', style: { padding: '20px 32px', overflowY: 'auto' } },
              p.summary
                ? h('div', { dangerouslySetInnerHTML: { __html: mdToHtml(p.summary) } })
                : h('pre', null, p.content || '')))
        }

        if (!file) return null
        const ext = file.path.slice(file.path.lastIndexOf('.')).toLowerCase()
        const parts = file.path.split('/')
        const stem = parts[parts.length - 1].replace(/\.[a-z0-9]+$/i, '')
        const currentTitle = title || stem
        const isText = file.kind === 'text'
        const toc = isText && ext === '.md' ? mdToc(draft || '') : []

        return h('div', { className: 'wb-detail' },
          h('div', { className: 'wb-detail-bar' },
            h('span', { className: 'wb-icon-btn', onClick: closeDetail, title: '返回' }, Icon.back(16)),
            h('span', { className: 'wb-crumb' },
              parts.map((p, i) => h('span', { key: i },
                i > 0 && h('span', { className: 'wb-crumb-sep' }, '/'),
                h('span', {
                  className: i === parts.length - 1 ? 'wb-crumb-cur' : 'wb-crumb-link',
                  onClick: i < parts.length - 1 ? () => { closeDetail(); setSection('files'); setCwd(parts.slice(0, i + 1).join('/')) } : undefined,
                }, p)))),
            h('span', { style: { flex: 1 } }),
            isText && h('span', { className: 'wb-save-state' }, saveState),
            isText && ext === '.md' && h('span', {
              className: 'wb-icon-btn' + (showToc ? ' on' : ''), title: '目录',
              onClick: () => setShowToc(v => !v),
            }, Icon.list(16))),
          h('div', { className: 'wb-detail-title-row' },
            h('input', {
              className: 'wb-detail-title',
              value: currentTitle,
              placeholder: '未命名',
              onChange: e => setTitle(e.target.value),
              onBlur: commitTitle,
              onKeyDown: e => { if (e.key === 'Enter') e.target.blur() },
            })),
          h('div', { className: 'wb-detail-body' },
            file.kind === 'loading'
              ? h('div', { className: 'wb-hint' }, '加载中…')
              : file.kind === 'error'
                ? h('div', { className: 'wb-hint' }, '读取失败')
                : file.kind === 'binary'
                  ? h('div', { className: 'wb-hint' }, '这个文件是二进制格式，暂不支持预览')
                  : file.kind === 'too-large'
                    ? h('div', { className: 'wb-hint' }, '文件过大，暂不支持预览')
                    : ext === '.html' || ext === '.htm'
                      ? h('iframe', { srcDoc: draft, sandbox: 'allow-scripts', title: file.path, className: 'wb-html-frame' })
                      : ext === '.csv'
                        ? h('div', { className: 'wb-csv' },
                            h('table', null,
                              draft.split('\n').filter(r => r.trim() !== '').map((row, ri) => h('tr', { key: ri },
                                row.split(',').map((cell, ci) => h(ri === 0 ? 'th' : 'td', { key: ci }, cell))))))
                        : ext === '.md'
                          ? h(React.Fragment, null,
                              h('div', {
                                className: 'wb-md wb-md-body',
                                dangerouslySetInnerHTML: { __html: mdToHtml(draft) },
                              }),
                              showToc && h('div', { className: 'wb-toc' },
                                toc.length
                                  ? toc.map(t => h('div', {
                                      key: t.idx,
                                      onClick: () => {
                                        const el = document.getElementById('toc-' + t.idx)
                                        if (el) el.scrollIntoView({ behavior: 'smooth' })
                                      },
                                      className: 'wb-toc-item',
                                      style: { paddingLeft: (t.level - 1) * 14 },
                                    }, t.text))
                                  : h('div', { className: 'wb-hint' }, '这个文件没有标题')))
                          : h('textarea', {
                              className: 'wb-editor',
                              value: draft,
                              onChange: e => { setDraft(e.target.value); scheduleSave(e.target.value) },
                              onBlur: () => { if (saveTimer.current) { clearTimeout(saveTimer.current); scheduleSave(draft) } },
                            })))
      }

      /* ── 面包屑（我的资料）── */
      const renderCrumb = () => {
        const parts = cwd ? cwd.split('/') : []
        return h('div', { className: 'wb-crumb wb-crumb-nav' },
          h('span', {
            className: parts.length === 0 ? 'wb-crumb-cur' : 'wb-crumb-link',
            onClick: () => setCwd(''),
          }, '我的资料'),
          parts.map((p, i) => h('span', { key: i },
            h('span', { className: 'wb-crumb-sep' }, '/'),
            h('span', {
              className: i === parts.length - 1 ? 'wb-crumb-cur' : 'wb-crumb-link',
              onClick: () => setCwd(parts.slice(0, i + 1).join('/')),
            }, p))))
      }

      /* ── 左侧菜单 ── */
      const navItem = (key, label, badge, warn) => h('div', {
        className: 'wb-nav-item' + (section === key && !file && !openPending ? ' active' : ''),
        onClick: () => {
          if (key === 'overlay') { setOverlay(true); return }
          closeDetail(); setSection(key); setQuery('')
        },
      }, Icon[{ recent: 'clock', overlay: 'robot', files: 'folder', pending: 'list' }[key]](15),
        h('span', { style: { flex: 1 } }, label),
        badge > 0 && h('span', { className: 'wb-badge' + (warn ? ' warn' : '') }, badge))

      const detailOpen = !!(file || openPending)

      /* ── 内容区 ── */
      const renderContent = () => {
        if (detailOpen) return renderDetail()
        const cols = [
          { label: '名称', sortKey: 'name', cls: 'wb-col-name-h' },
          { label: '类型', cls: 'wb-col-type' },
          { label: '更新人', cls: 'wb-col-author' },
          { label: '更新时间', sortKey: 'time', cls: 'wb-col-time' },
          { label: '大小', cls: 'wb-col-size' },
        ]
        if (searchHits !== null) {
          return h(React.Fragment, null,
            h('div', { className: 'wb-search-meta' }, '搜索「' + query + '」：' + (searchHits ? searchHits.length : 0) + ' 条结果'),
            h('div', { className: 'wb-list' }, searchRows()))
        }
        if (section === 'recent') {
          return h(React.Fragment, null,
            h('div', { className: 'wb-crumb' }, h('span', { className: 'wb-crumb-cur' }, '最近使用')),
            listHeader(cols),
            h('div', { className: 'wb-list' }, recentRows()))
        }
        if (section === 'pending') {
          return h(React.Fragment, null,
            h('div', { className: 'wb-crumb' }, h('span', { className: 'wb-crumb-cur' }, '待确认')),
            listHeader(cols.map(c => c.label === '名称' ? { ...c, label: '文件', sortKey: undefined } : c)),
            h('div', { className: 'wb-list' }, pendingRows()))
        }
        return h(React.Fragment, null,
          renderCrumb(),
          listHeader(cols),
          h('div', { className: 'wb-list' }, fileRows()))
      }

      return h('div', { className: 'wb-panel' },
        /* 左侧菜单 */
        h('div', { className: 'wb-sidemenu' },
          h('div', { className: 'wb-side-title' }, '资料库'),
          h('div', { className: 'wb-new-wrap' },
            h('div', {
              className: 'wb-nav-item' + (showNew ? ' active' : ''),
              onClick: () => setShowNew(v => !v),
            }, Icon.plus(15), h('span', { style: { flex: 1 } }, '新建'),
              h('span', { className: 'wb-chevron down' }, Icon.chevron(12))),
            showNew && h(React.Fragment, null,
              h('div', { className: 'wb-menu-mask', onClick: () => setShowNew(false) }),
              h('div', { className: 'wb-menu wb-menu-newside' },
                h('div', { className: 'wb-menu-item', onClick: () => createNew('md') }, Icon.doc(15), '新建文档（.md）'),
                h('div', { className: 'wb-menu-item', onClick: () => createNew('csv') }, Icon.sheet(15), '新建表格（.csv）'),
                h('div', { className: 'wb-menu-item', onClick: () => createNew('html') }, Icon.web(15), '新建网页（.html）'),
                h('div', { className: 'wb-menu-item', onClick: () => createNew('docx') },
                  h('span', { style: { color: '#2b579a', display: 'inline-flex' } }, Icon.doc(15)), 'Word 文档（.docx）'),
                h('div', { className: 'wb-menu-item', onClick: () => createNew('xlsx') },
                  h('span', { style: { color: '#217346', display: 'inline-flex' } }, Icon.sheet(15)), 'Excel 表格（.xlsx）'),
                h('div', { className: 'wb-menu-item', onClick: () => createNew('pptx') },
                  h('span', { style: { color: '#d24726', display: 'inline-flex' } }, Icon.web(15)), 'PPT 演示（.pptx）'),
                h('div', { className: 'wb-menu-sep' }),
                h('div', { className: 'wb-menu-item', onClick: () => { setShowNew(false); uploadInput.current && uploadInput.current.click() } }, Icon.plus(15), '上传文件'),
                h('div', { className: 'wb-menu-item', onClick: () => { setShowNew(false); importInput.current && importInput.current.click() } }, Icon.inbox(15), '导入文件夹'),
                h('div', { className: 'wb-menu-item', onClick: () => { setShowNew(false); setLinkForm({ name: '', url: '' }); setShowLink(true) } }, Icon.web(15), '添加链接'),
                h('div', { className: 'wb-menu-sep' }),
                h('div', { className: 'wb-menu-item', onClick: () => createNew('dir') }, Icon.folder(15), '新建文件夹')))),
          navItem('recent', '最近使用'),
          navItem('overlay', '本地产物'),
          navItem('files', '我的资料'),
          navItem('pending', '待确认', pending.length, true),
          h('div', { style: { flex: 1 } }),
          pins.length > 0 && h('div', { className: 'wb-pins-hint', title: pins.map(p => p.relPath).join('\n') },
            Icon.pin(12), ' 固定引用 ' + pins.length),
          h('div', { className: 'wb-nav-item', onClick: openCloud }, Icon.cloud(15), h('span', { style: { flex: 1 } }, '云同步'),
            cloudHasSaved && h('span', { className: 'wb-dot-on', title: '已配置' })),
          h('span', { className: 'wb-icon-btn wb-side-refresh', title: '刷新', onClick: refresh }, Icon.refresh(15))),
        /* 右侧内容区 */
        h('div', { className: 'wb-content' },
          !detailOpen && h('div', { className: 'wb-toolbar' },
            h('div', { className: 'wb-toolbar-left' },
              h('div', { className: 'wb-search' },
                Icon.search(14),
                h('input', {
                  value: query,
                  onChange: e => setQuery(e.target.value),
                  placeholder: '搜索全库内容…',
                }),
                query && h('span', { className: 'wb-search-clear', onClick: () => setQuery('') }, Icon.x(12))),
              searchHits === null && section === 'files' && h(React.Fragment, null,
                h('div', { className: 'wb-filter' },
                  h('button', {
                    type: 'button',
                    className: 'wb-filter-btn' + (typeFilter !== 'all' ? ' on' : ''),
                    onClick: () => setShowFilter(v => !v),
                  }, { all: '全部类型', doc: '文档', sheet: '表格', web: '网页', other: '其他', dir: '文件夹' }[typeFilter], h('span', { className: 'wb-chevron down' }, Icon.chevron(12))),
                  showFilter && h(React.Fragment, null,
                    h('div', { className: 'wb-menu-mask', onClick: () => setShowFilter(false) }),
                    h('div', { className: 'wb-filter-menu' },
                      [['all', '全部类型'], ['doc', '文档'], ['sheet', '表格'], ['web', '网页'], ['dir', '文件夹'], ['other', '其他']]
                        .map(([v, label]) => h('div', {
                          key: v,
                          className: 'wb-menu-item' + (typeFilter === v ? ' active' : ''),
                          onClick: () => { setTypeFilter(v); setShowFilter(false) },
                        }, label))))),
                h('label', { className: 'wb-fav-filter' + (favOnly ? ' on' : '') },
                  h('input', { type: 'checkbox', checked: favOnly, onChange: () => setFavOnly(v => !v) }),
                  '仅看收藏')))),
          renderContent()),
        /* 多选操作条 */
        selected.size > 0 && !detailOpen && h('div', { className: 'wb-selbar' },
          h('span', { className: 'wb-selbar-count' }, '已选 ' + selected.size + ' 项'),
          h('button', { className: 'wb-mini-btn', onClick: () => { copyText([...selected].join('\n'), '已复制 ' + selected.size + ' 条路径') } }, '复制路径'),
          h('button', { className: 'wb-mini-btn', onClick: () => setSelected(new Set()) }, '取消')),
        renderOverlay(),
        renderMenu(),
        h('input', {
          type: 'file', multiple: true, ref: uploadInput, style: { display: 'none' },
          onChange: e => { uploadFiles(e.target.files, false); e.target.value = '' },
        }),
        h('input', {
          type: 'file', ref: importInput, style: { display: 'none' }, webkitdirectory: '',
          onChange: e => { uploadFiles(e.target.files, true); e.target.value = '' },
        }),
        showLink && h('div', { className: 'wb-modal-mask', onClick: () => setShowLink(false) },
          h('div', { className: 'wb-modal', onClick: e => e.stopPropagation() },
            h('div', { className: 'wb-modal-title' }, '添加链接'),
            h('input', {
              className: 'wb-modal-input', placeholder: '名称', value: linkForm.name, autoFocus: true,
              onChange: e => setLinkForm(f => ({ ...f, name: e.target.value })),
            }),
            h('input', {
              className: 'wb-modal-input', placeholder: 'https://…', value: linkForm.url,
              onChange: e => setLinkForm(f => ({ ...f, url: e.target.value })),
              onKeyDown: e => { if (e.key === 'Enter') addLink() },
            }),
            h('div', { className: 'wb-modal-actions' },
              h('button', { className: 'wb-mini-btn', onClick: () => setShowLink(false) }, '取消'),
              h('button', { className: 'wb-mini-btn ok', onClick: addLink }, '添加')))),
        showCloud && h('div', { className: 'wb-modal-mask', onClick: () => setShowCloud(false) },
          h('div', { className: 'wb-modal wide', onClick: e => e.stopPropagation() },
            h('div', { className: 'wb-modal-title' }, '云同步'),
            h('div', { className: 'wb-modal-sub' }, '本地库保持不变，云端做镜像；按修改时间新盖旧，删除不同步'),
            h('div', { className: 'wb-field' },
              h('span', { className: 'wb-field-label' }, '协议'),
              h('span', { className: 'wb-modal-static' }, '腾讯云 COS')),
            h('div', { className: 'wb-field' },
              h('span', { className: 'wb-field-label' }, '地址'),
              h('input', {
                className: 'wb-modal-input', value: cloudCfg.endpoint,
                placeholder: 'https://cos.ap-guangzhou.myqcloud.com',
                onChange: e => setCloudCfg(c => ({ ...c, endpoint: e.target.value })),
              })),
            h('div', { className: 'wb-field' },
              h('span', { className: 'wb-field-label' }, 'Bucket'),
              h('input', {
                className: 'wb-modal-input', value: cloudCfg.bucket,
                placeholder: '存储桶名-APPID，如 mylib-1300000000',
                onChange: e => setCloudCfg(c => ({ ...c, bucket: e.target.value })),
              })),
            h('div', { className: 'wb-field' },
              h('span', { className: 'wb-field-label' }, '账号'),
              h('input', {
                className: 'wb-modal-input', value: cloudCfg.accessKey,
                placeholder: 'SecretId',
                onChange: e => setCloudCfg(c => ({ ...c, accessKey: e.target.value })),
              })),
            h('div', { className: 'wb-field' },
              h('span', { className: 'wb-field-label' }, '密钥'),
              h('input', {
                className: 'wb-modal-input', type: 'password', value: cloudCfg.secretKey,
                placeholder: cloudHasSaved ? '已保存，不修改可留空' : 'SecretKey',
                onChange: e => setCloudCfg(c => ({ ...c, secretKey: e.target.value })),
              })),
            h('div', { className: 'wb-field' },
              h('span', { className: 'wb-field-label' }, '前缀'),
              h('input', {
                className: 'wb-modal-input', value: cloudCfg.prefix, placeholder: 'dsh-library',
                onChange: e => setCloudCfg(c => ({ ...c, prefix: e.target.value })),
              })),
            cloudCfg.protocol === 's3' && h('div', { className: 'wb-field' },
              h('span', { className: 'wb-field-label' }, 'Region'),
              h('input', {
                className: 'wb-modal-input', value: cloudCfg.region, placeholder: '留空自动识别；R2 填 auto',
                onChange: e => setCloudCfg(c => ({ ...c, region: e.target.value })),
              })),
            h('label', { className: 'wb-fav-filter', style: { alignSelf: 'flex-start' } },
              h('input', {
                type: 'checkbox', checked: cloudCfg.autoPush,
                onChange: e => setCloudCfg(c => ({ ...c, autoPush: e.target.checked })),
              }),
              '文件变动后自动同步'),
            cloudStatus && h('div', { className: 'wb-cloud-status' }, cloudStatus),
            h('div', { className: 'wb-modal-actions' },
              h('button', { className: 'wb-mini-btn', disabled: cloudBusy, onClick: testCloudConn }, '测试连接'),
              h('button', { className: 'wb-mini-btn', disabled: cloudBusy || !cloudHasSaved, onClick: syncCloudNow }, '立即同步'),
              h('button', { className: 'wb-mini-btn ok', disabled: cloudBusy, onClick: saveCloud }, '保存')))),
        msg ? h('div', { className: 'wb-toast', onClick: () => setMsg('') }, msg) : null)
    }

    /* ── 主题：浅色对齐 WorkBuddy 资料库，深色配套 ── */
    const THEME_CSS = `
      .wb-panel {
        --wb-bg: #ffffff; --wb-bg-sub: #f7f8fa; --wb-hover: rgba(0,0,0,.045);
        --wb-active: rgba(0,0,0,.07); --wb-line: #ececec; --wb-line-strong: #e0e0e0;
        --wb-fg: #1f2329; --wb-fg2: #646a73; --wb-dim: #8f959e;
        --wb-accent: #3370ff; --wb-warn: #b26b00; --wb-warn-bg: #fff7e6;
        --wb-danger: #d83931; --wb-pop: #ffffff; --wb-shadow: 0 6px 24px rgba(31,35,41,.12);
        display: flex; height: 100%; min-height: 0; position: relative; overflow: hidden;
        background: var(--wb-bg); color: var(--wb-fg);
        font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        font-size: 14px; color-scheme: light;
      }
      @media (prefers-color-scheme: dark) {
        .wb-panel {
          --wb-bg: #1c1e24; --wb-bg-sub: #22242c; --wb-hover: rgba(255,255,255,.055);
          --wb-active: rgba(255,255,255,.09); --wb-line: rgba(255,255,255,.08); --wb-line-strong: rgba(255,255,255,.14);
          --wb-fg: #e8eaf0; --wb-fg2: #a8afbb; --wb-dim: #6f7683;
          --wb-accent: #6b9eff; --wb-warn: #f0b35e; --wb-warn-bg: rgba(240,179,94,.12);
          --wb-danger: #e5645d; --wb-pop: #262932; --wb-shadow: 0 6px 24px rgba(0,0,0,.4);
          color-scheme: dark;
        }
      }
      .wb-panel * { box-sizing: border-box; }

      /* 左侧菜单 */
      .wb-sidemenu { width: 200px; flex-shrink: 0; display: flex; flex-direction: column; gap: 2px;
        padding: 16px 12px 12px; border-right: 1px solid var(--wb-line); background: var(--wb-bg-sub); }
      .wb-side-title { font-size: 16px; font-weight: 600; padding: 2px 10px 12px; }
      .wb-new-wrap { position: relative; }
      .wb-menu.wb-menu-newside { position: absolute; top: calc(100% + 4px); left: 0; right: 0; }
      .wb-nav-item { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 8px;
        font-size: 13px; color: var(--wb-fg2); cursor: pointer; transition: background .12s, color .12s; }
      .wb-nav-item:hover { background: var(--wb-hover); color: var(--wb-fg); }
      .wb-nav-item.active { background: var(--wb-active); color: var(--wb-fg); font-weight: 600; }
      .wb-side-refresh { align-self: flex-start; margin-top: 4px; }
      .wb-pins-hint { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--wb-dim); padding: 4px 10px; }
      .wb-badge { display: inline-flex; align-items: center; justify-content: center; padding: 1px 7px;
        border-radius: 999px; font-size: 11px; font-weight: 600; background: var(--wb-active); color: var(--wb-fg2); }
      .wb-badge.warn { background: var(--wb-warn-bg); color: var(--wb-warn); }

      /* 右侧内容区 */
      .wb-content { flex: 1; min-width: 0; display: flex; flex-direction: column; }

      /* 工具栏 */
      .wb-toolbar { display: flex; align-items: center; gap: 8px; padding: 12px 24px; flex-shrink: 0; }
      .wb-toolbar-left { display: flex; align-items: center; gap: 8px; }
      .wb-search { display: flex; align-items: center; gap: 6px; height: 32px; min-width: 220px; max-width: 360px; flex: 280px;
        border: 1px solid var(--wb-line-strong); border-radius: 8px; padding: 0 10px; color: var(--wb-dim);
        transition: border-color .2s; }
      .wb-search:focus-within { border-color: var(--wb-accent); color: var(--wb-fg2); }
      .wb-search input { flex: 1; min-width: 0; border: none; outline: none; background: none;
        color: var(--wb-fg); font-size: 12px; font-weight: 500; }
      .wb-search input::placeholder { color: var(--wb-dim); }
      .wb-search-clear { cursor: pointer; display: inline-flex; padding: 2px; border-radius: 4px; }
      .wb-search-clear:hover { background: var(--wb-hover); }
      .wb-filter { position: relative; }
      .wb-filter-btn { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px;
        border: 1px solid var(--wb-line-strong); border-radius: 8px; background: var(--wb-bg);
        color: var(--wb-fg2); font-size: 12px; font-weight: 500; cursor: pointer; transition: border-color .15s, color .15s; }
      .wb-filter-btn:hover, .wb-filter-btn.on { color: var(--wb-fg); border-color: var(--wb-dim); }
      .wb-chevron.down { transform: rotate(90deg); display: inline-flex; }
      .wb-filter-menu { position: absolute; top: calc(100% + 4px); left: 0; z-index: 60; min-width: 140px;
        background: var(--wb-pop); border: 1px solid var(--wb-line); border-radius: 10px;
        box-shadow: var(--wb-shadow); padding: 6px; }
      .wb-filter-menu .wb-menu-item.active { font-weight: 600; color: var(--wb-accent); }
      .wb-fav-filter { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--wb-fg2);
        cursor: pointer; user-select: none; white-space: nowrap; }
      .wb-fav-filter.on { color: var(--wb-fg); }
      .wb-fav-filter input { accent-color: var(--wb-accent); margin: 0; }

      /* 面包屑 */
      .wb-crumb { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--wb-dim);
        padding: 2px 24px 8px; flex-wrap: wrap; }
      .wb-crumb-link { cursor: pointer; border-radius: 4px; padding: 0 2px; }
      .wb-crumb-link:hover { color: var(--wb-fg); background: var(--wb-hover); }
      .wb-crumb-cur { color: var(--wb-fg); font-weight: 500; }
      .wb-crumb-sep { color: var(--wb-line-strong); }
      .wb-search-meta { padding: 2px 24px 8px; font-size: 12px; color: var(--wb-dim); }

      /* 列表 */
      .wb-body { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 0 24px 12px; overflow: hidden; }
      .wb-list { flex: 1; min-height: 0; overflow-y: auto; }
      .wb-list::-webkit-scrollbar { width: 8px; }
      .wb-list::-webkit-scrollbar-thumb { background: var(--wb-line-strong); border-radius: 4px; }
      .wb-list-header { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 16px;
        padding: 10px 16px; border-bottom: 1px solid var(--wb-line); background: var(--wb-bg);
        color: var(--wb-dim); font-size: 13px; font-weight: 600; letter-spacing: .3px; }
      .wb-list-header .sortable { cursor: pointer; user-select: none; display: inline-flex; align-items: center; gap: 2px; }
      .wb-list-header .sortable:hover, .wb-list-header .is-sorted { color: var(--wb-fg); }
      .wb-sort-arrow { font-size: 11px; }
      .wb-row { display: flex; align-items: center; gap: 16px; height: 46px; padding: 0 16px;
        font-size: 14px; cursor: default; transition: background .12s; border-radius: 6px; }
      .wb-row:hover { background: var(--wb-hover); }
      .wb-row.is-selected { background: var(--wb-active); }
      .wb-row.is-open { background: var(--wb-hover); }
      .wb-row-group { cursor: pointer; }
      .wb-row-group .wb-taskname { font-weight: 600; color: var(--wb-fg); }
      .wb-row-l1 { cursor: pointer; padding-left: 36px; }
      .wb-row-l2 { padding-left: 72px; }
      .wb-checkcol { width: 20px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
      .wb-checkbox { width: 16px; height: 16px; border: 1.5px solid var(--wb-dim); border-radius: 3px;
        display: inline-flex; align-items: center; justify-content: center; color: #fff;
        opacity: 0; transition: opacity .15s, background .15s; cursor: pointer; }
      .wb-row:hover .wb-checkbox, .wb-checkbox.on { opacity: 1; }
      .wb-checkbox.on { background: var(--wb-accent); border-color: var(--wb-accent); }
      .wb-chevron { width: 20px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
        color: var(--wb-fg2); transition: transform .15s; }
      .wb-chevron.open { transform: rotate(90deg); }
      .wb-col-name { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; overflow: hidden; color: var(--wb-fg2); }
      .wb-col-name-h { flex: 1; }
      .wb-filename { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--wb-fg); font-weight: 400; }
      .wb-filename.clickable { cursor: pointer; }
      .wb-filename.clickable:hover { text-decoration: underline; }
      .wb-subpath { font-size: 12px; color: var(--wb-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wb-star { color: #f5a623; display: inline-flex; flex-shrink: 0; }
      .wb-pin { color: var(--wb-dim); display: inline-flex; flex-shrink: 0; }
      .wb-pin.drifted { color: var(--wb-warn); }
      .wb-spark { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px;
        border-radius: 4px; color: var(--wb-fg2); opacity: 0; transition: opacity .15s, background .15s; flex-shrink: 0; }
      .wb-row:hover .wb-spark { opacity: 1; }
      .wb-spark:hover { background: var(--wb-active); color: var(--wb-fg); }
      .wb-pill { flex-shrink: 0; height: 18px; padding: 0 8px; border-radius: 6px; background: var(--wb-bg-sub);
        color: var(--wb-fg2); font-size: 11px; font-weight: 500; display: inline-flex; align-items: center; }
      .wb-tag { flex-shrink: 0; height: 18px; padding: 0 6px; border-radius: 4px; background: var(--wb-bg-sub);
        color: var(--wb-fg2); font-size: 11px; display: inline-flex; align-items: center; }
      .wb-tag.warn { background: var(--wb-warn-bg); color: var(--wb-warn); }
      .wb-col { width: 88px; flex-shrink: 0; color: var(--wb-fg2); font-size: 13px; text-align: left;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wb-col-actions { width: 60px; flex-shrink: 0; display: flex; align-items: center; justify-content: flex-end; gap: 4px; }
      .wb-row .wb-col-actions { opacity: 0; transition: opacity .15s; }
      .wb-row:hover .wb-col-actions, .wb-row.is-selected .wb-col-actions, .wb-row .wb-row-actions-visible { opacity: 1; }
      .wb-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px;
        border-radius: 6px; color: var(--wb-fg2); cursor: pointer; transition: background .12s, color .12s; }
      .wb-icon-btn:hover { background: var(--wb-active); color: var(--wb-fg); }
      .wb-icon-btn.on { color: var(--wb-accent); }
      .wb-hit-line { font-size: 12px; color: var(--wb-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
      .wb-rename { flex: 1; min-width: 0; font-size: 13px; padding: 2px 6px; border: 1px solid var(--wb-accent);
        border-radius: 4px; background: var(--wb-bg); color: var(--wb-fg); outline: none; }
      .wb-mini-btn { height: 26px; padding: 0 10px; border: 1px solid var(--wb-line-strong); border-radius: 6px;
        background: var(--wb-bg); color: var(--wb-fg); font-size: 12px; cursor: pointer; }
      .wb-mini-btn:hover { border-color: var(--wb-dim); }
      .wb-mini-btn.ok { background: var(--wb-accent); border-color: var(--wb-accent); color: #fff; }
      .wb-mini-btn.ok:hover { filter: brightness(1.08); }

      /* 空状态 */
      .wb-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 8px; padding: 64px 24px; color: var(--wb-dim); font-size: 14px; text-align: center; }
      .wb-empty-icon { color: var(--wb-line-strong); margin-bottom: 4px; }
      .wb-empty-sub { font-size: 12px; }

      /* 浮层菜单 */
      .wb-menu-mask { position: fixed; inset: 0; z-index: 70; }
      .wb-menu { position: fixed; z-index: 71; min-width: 168px; background: var(--wb-pop);
        border: 1px solid var(--wb-line); border-radius: 10px; box-shadow: var(--wb-shadow); padding: 6px; }
      .wb-menu-item { display: flex; align-items: center; gap: 10px; padding: 8px 12px; font-size: 13px;
        color: var(--wb-fg); border-radius: 6px; cursor: pointer; white-space: nowrap; }
      .wb-menu-item:hover { background: var(--wb-hover); }
      .wb-menu-item.danger { color: var(--wb-danger); }
      .wb-menu-item.has-sub { justify-content: space-between; }
      .wb-menu-sep { height: 1px; margin: 4px 8px; background: var(--wb-line); }
      .wb-menu-sub { position: relative; }
      .wb-submenu { display: none; position: absolute; right: calc(100% + 2px); top: -6px; min-width: 150px; max-height: 260px;
        overflow-y: auto; background: var(--wb-pop); border: 1px solid var(--wb-line); border-radius: 10px;
        box-shadow: var(--wb-shadow); padding: 6px; }
      .wb-menu-sub:hover .wb-submenu, .wb-menu-sub:focus-within .wb-submenu { display: block; }

      /* 多选操作条 */
      .wb-selbar { position: absolute; left: 50%; bottom: 20px; transform: translateX(-50%); z-index: 55;
        display: flex; align-items: center; gap: 10px; padding: 8px 14px; background: var(--wb-pop);
        border: 1px solid var(--wb-line); border-radius: 10px; box-shadow: var(--wb-shadow); }
      .wb-selbar-count { font-size: 13px; color: var(--wb-fg2); }

      /* 本地产物弹层（覆盖整页） */
      .wb-overlay { position: absolute; inset: 0; z-index: 30; display: flex; flex-direction: column;
        background: var(--wb-bg); animation: wb-fadein .15s ease; }
      @keyframes wb-fadein { from { opacity: 0 } to { opacity: 1 } }
      .wb-overlay-top { display: flex; align-items: center; gap: 12px; padding: 14px 24px 4px; flex-shrink: 0; }
      .wb-back-link { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--wb-fg2);
        cursor: pointer; padding: 4px 8px; border-radius: 6px; }
      .wb-back-link:hover { background: var(--wb-hover); color: var(--wb-fg); }
      .wb-overlay-title { font-size: 16px; font-weight: 600; }

      /* 右侧抽屉 */
      .wb-drawer { position: absolute; top: 0; right: 0; bottom: 0; width: min(560px, 58%); z-index: 40;
        display: flex; flex-direction: column; background: var(--wb-bg);
        border-left: 1px solid var(--wb-line); box-shadow: -8px 0 24px rgba(0,0,0,.08);
        animation: wb-slidein .18s ease; }
      @keyframes wb-slidein { from { transform: translateX(40px); opacity: 0 } to { transform: none; opacity: 1 } }
      .wb-drawer-head { display: flex; align-items: center; gap: 8px; padding: 12px 16px;
        border-bottom: 1px solid var(--wb-line); flex-shrink: 0; color: var(--wb-fg2); }
      .wb-drawer-title { font-size: 14px; font-weight: 600; color: var(--wb-fg);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wb-drawer-path { padding: 6px 16px; font-size: 12px; color: var(--wb-dim); flex-shrink: 0;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wb-drawer-body { flex: 1; min-height: 0; display: flex; overflow: hidden; }
      .wb-pre { flex: 1; margin: 0; overflow: auto; padding: 20px 24px; font-size: 13px; line-height: 1.7;
        font-family: Consolas, Menlo, monospace; color: var(--wb-fg); white-space: pre-wrap; word-break: break-all; }

      /* 详情页 */
      .wb-detail { flex: 1; min-height: 0; display: flex; flex-direction: column; }
      .wb-detail-bar { display: flex; align-items: center; gap: 10px; padding: 10px 16px 0; }
      .wb-detail-bar .wb-crumb { padding: 0; }
      .wb-save-state { font-size: 12px; color: var(--wb-dim); }
      .wb-detail-title-row { display: flex; align-items: center; gap: 10px; padding: 8px 16px 12px;
        border-bottom: 1px solid var(--wb-line); }
      .wb-detail-title { flex: 1; min-width: 0; border: 0; outline: none; background: transparent;
        color: var(--wb-fg); font-size: 22px; font-weight: 600; padding: 2px 0; font-family: inherit; }
      .wb-detail-body { flex: 1; min-height: 0; display: flex; }
      .wb-hint { flex: 1; padding: 24px; color: var(--wb-dim); font-size: 13px; }
      .wb-md-body { flex: 1; min-width: 0; overflow-y: auto; padding: 24px 32px; font-size: 15px; line-height: 1.85; }
      .wb-toc { width: 220px; flex-shrink: 0; border-left: 1px solid var(--wb-line); overflow-y: auto; padding: 12px; }
      .wb-toc-item { font-size: 12px; cursor: pointer; padding: 4px 6px; border-radius: 6px; color: var(--wb-fg2);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wb-toc-item:hover { background: var(--wb-hover); color: var(--wb-fg); }
      .wb-editor { flex: 1; border: 0; outline: none; resize: none; background: transparent; color: var(--wb-fg);
        font-size: 14px; line-height: 1.8; font-family: Consolas, Menlo, monospace; padding: 24px 32px; }
      .wb-html-frame { flex: 1; border: 0; width: 100%; background: #fff; }
      .wb-csv { flex: 1; overflow: auto; padding: 20px; }
      .wb-csv table { border-collapse: collapse; font-size: 13px; width: 100%; }
      .wb-csv th, .wb-csv td { border: 1px solid var(--wb-line); padding: 5px 12px; text-align: left; }
      .wb-csv th { background: var(--wb-bg-sub); font-weight: 600; }

      /* Markdown 渲染 */
      .wb-md h1, .wb-md h2, .wb-md h3, .wb-md h4 { margin: 1.2em 0 .5em; border-bottom: 1px solid var(--wb-line); padding-bottom: .25em; color: var(--wb-fg); }
      .wb-md p { margin: .7em 0; }
      .wb-md pre { background: var(--wb-bg-sub); border: 1px solid var(--wb-line); border-radius: 8px; padding: 12px; overflow-x: auto; }
      .wb-md code { font-family: Consolas, Menlo, monospace; font-size: 13px; }
      .wb-md blockquote { border-left: 3px solid var(--wb-line); margin: .7em 0; padding: .3em 1em; color: var(--wb-dim); }
      .wb-md table { border-collapse: collapse; margin: .9em 0; }
      .wb-md th, .wb-md td { border: 1px solid var(--wb-line); padding: 5px 12px; font-size: 13px; }
      .wb-md a { color: var(--wb-accent); }

      /* 提示条 */
      .wb-toast { position: absolute; left: 50%; bottom: 72px; transform: translateX(-50%); z-index: 80;
        padding: 8px 16px; border-radius: 8px; background: var(--wb-fg); color: var(--wb-bg);
        font-size: 12px; cursor: pointer; box-shadow: var(--wb-shadow); }

      /* 链接弹窗 */
      .wb-modal-mask { position: fixed; inset: 0; z-index: 90; background: rgba(0,0,0,.35);
        display: flex; align-items: center; justify-content: center; }
      .wb-modal { width: 320px; background: var(--wb-pop); border-radius: 12px; box-shadow: var(--wb-shadow);
        padding: 18px; display: flex; flex-direction: column; gap: 10px; }
      .wb-modal.wide { width: 420px; }
      .wb-modal-sub { font-size: 12px; color: var(--wb-dim); margin-top: -4px; }
      .wb-field { display: flex; align-items: center; gap: 10px; }
      .wb-field-label { width: 44px; flex-shrink: 0; font-size: 12px; color: var(--wb-fg2); text-align: right; }
      .wb-field .wb-modal-input { flex: 1; }
      .wb-modal-static { font-size: 13px; color: var(--wb-fg); }
      .wb-cloud-status { font-size: 12px; color: var(--wb-fg2); background: var(--wb-bg-sub);
        border-radius: 6px; padding: 6px 10px; word-break: break-all; }
      .wb-dot-on { width: 7px; height: 7px; border-radius: 50%; background: var(--wb-accent); flex-shrink: 0; }
      select.wb-modal-input { appearance: auto; }
      .wb-modal-title { font-size: 15px; font-weight: 600; }
      .wb-modal-input { height: 34px; padding: 0 10px; border: 1px solid var(--wb-line-strong); border-radius: 8px;
        background: var(--wb-bg); color: var(--wb-fg); font-size: 13px; outline: none; }
      .wb-modal-input:focus { border-color: var(--wb-accent); }
      .wb-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
    `

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-wb-desk')
        style.textContent = THEME_CSS
        document.head.appendChild(style)
        return () => { style.remove() }
      }, 'dsh-wb-desk: theme')
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: 'dsh-wb-desk' }, () => h(LibraryPage)))
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: 'dsh-wb-desk', order: 36, label: () => '资料库' },
          PanelIcon))
    }

    return { name: 'dsh-wb-desk', inject: ['slots'], apply }
  },
})

