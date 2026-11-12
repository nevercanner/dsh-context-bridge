/**
 * dsh-context-bridge · Client 半
 * 只做两件事：在会话行「…」菜单里放一个开关行、在侧栏放一个面板图标。
 *
 * ⚠️ 安全约束（这是本插件的硬规则，不能改）：
 *   1. **不做 DOM 变更观察**。dsh-session-send 曾用变更观察器扫描所有 role="menu"
 *      再往容器里塞自建节点，导致「插入 → React 重渲染 → 再插入」的自激，
 *      打开模型菜单会把渲染进程主线程锁死。这里只走官方 slot 注册。
 *   2. **不直接操纵宿主容器**。插行只通过 slots.register，不碰别人的子树。
 *   3. **不在渲染期测量 DOM**。没有任何布局尺寸读取（那会强制同步布局）。
 *   4. **不轮询、不自续帧**。状态只在组件挂载时读一次，之后由用户操作驱动。
 *   以上四条由 tests/client-safety.test.mjs 静态扫描把关。
 *
 * 组件全部用 React.createElement，不装 JSX 编译。
 */
window.__ModuleLoader__.load({
  id: 'dsh-context-bridge',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-context-bridge'

    /** 由 apply(ctx) 注入：交接成功后切换到新会话的宿主 API（uiWorkspace.openSession）。 */
    let openSessionInHost = undefined

    /**
     * 交接成功后切到新会话。遵循项目配置 openNewSession（host 侧已解析，这里通过
     * 全局默认 true 兜底；若当前宿主未提供 uiWorkspace 则安全跳过 —— 新建会话本身
     * 已完成并且已持久化，切不切换只是视图导航）。
     */
    async function revealNewSession(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      try {
        if (typeof openSessionInHost === 'function') {
          openSessionInHost(sessionId)
        } else {
          // 兜底：通过 location.search 的 session 参数通知宿主侧栏（仅当宿主支持）
          try {
            const url = new URL(window.location.href)
            url.searchParams.set('session', sessionId)
            window.history.replaceState({}, '', url.toString())
          } catch {
            // 忽略：宿主不支持 URL 导航
          }
        }
      } catch (error) {
        // 切换失败不阻断 —— 交接文档已经建好，会话在磁盘上，用户可自行切过去。
        console.info('[dsh-context-bridge] 切换新会话失败（可忽略，会话已创建）:', String(error))
      }
    }

    function api(path, options) {
      const init = {
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        ...options,
      }
      return fetch(path, init).then(async (response) => {
        const text = await response.text()
        let body
        try {
          body = text === '' ? {} : JSON.parse(text)
        } catch {
          body = { error: { message: text.slice(0, 200) } }
        }
        if (!response.ok) {
          const message = body?.error?.message ?? body?.detail ?? `HTTP ${response.status}`
          throw new Error(message)
        }
        return body
      })
    }

    /** 当前会话 id：宿主把它放在 location.search 上（与 dsh-session-send 同源）。 */
    function readSessionId() {
      try {
        const params = new URLSearchParams(window.location.search)
        return params.get('session') ?? params.get('sessionId') ?? ''
      } catch {
        return ''
      }
    }

    /** 小圆点：不开/开两种状态，纯 CSS，无动画。 */
    function Dot(props) {
      return h('span', {
        style: {
          width: 7,
          height: 7,
          borderRadius: '50%',
          flex: 'none',
          background: props.on ? '#3c9' : '#888',
        },
      })
    }

    /**
     * 会话行菜单里的一行：点击 = 立即生成交接文档并开新会话。
     * 只在挂载时读一次状态，之后完全由用户点击驱动。
     */
    function HandoffMenuItem(props) {
      const sessionId = typeof props?.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : readSessionId()
      const [state, setState] = React.useState({ loading: true, enabled: false, status: '', name: '' })
      const [busy, setBusy] = React.useState(false)
      const [result, setResult] = React.useState('')

      React.useEffect(() => {
        let alive = true
        if (sessionId === '') {
          setState({ loading: false, enabled: false, status: '无法确定会话', name: '' })
          return () => {
            alive = false
          }
        }
        api(`/plugins/dsh-context-bridge/status?session=${encodeURIComponent(sessionId)}`)
          .then((body) => {
            if (!alive) return
            setState({
              loading: false,
              enabled: body?.enabled === true,
              status: String(body?.status ?? ''),
              name: String(body?.busName ?? ''),
            })
          })
          .catch((error) => {
            if (alive) setState({ loading: false, enabled: false, status: String(error?.message ?? error), name: '' })
          })
        return () => {
          alive = false
        }
      }, [sessionId])

      const run = React.useCallback(async () => {
        if (busy) return
        setBusy(true)
        setResult('')
        try {
          const body = await api('/plugins/dsh-context-bridge/run', {
            method: 'POST',
            body: JSON.stringify({ session: sessionId }),
          })
          const name = typeof body?.name === 'string' && body.name !== '' ? `「${body.name}」` : ''
          const newId = typeof body?.sessionId === 'string' ? body.sessionId : ''
          setResult(`已开新会话${name}`)
          // 交接成功后真正切到新会话（config.openNewSession 默认 true）
          await revealNewSession(newId)
        } catch (error) {
          setResult(`失败：${String(error?.message ?? error)}`)
        } finally {
          setBusy(false)
        }
      }, [busy, sessionId])

      const label = result !== '' ? `上下文交接：${result}` : busy ? '上下文交接：生成中…' : '上下文交接：生成并续接'
      const title =
        result !== '' ? result : `把当前会话压成交接文档，开一个新会话继续。状态：${state.status || '读取中…'}`

      return h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          disabled: busy || sessionId === '',
          title,
          onClick: (event) => {
            event.stopPropagation()
            void run()
          },
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            padding: '6px 10px',
            border: 0,
            background: 'transparent',
            color: 'inherit',
            font: 'inherit',
            textAlign: 'left',
            cursor: busy ? 'progress' : 'pointer',
            opacity: busy || sessionId === '' ? 0.6 : 1,
          },
        },
        h(Dot, { on: state.enabled }),
        h(
          'span',
          {
            style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          },
          label,
        ),
      )
    }

    /** 侧栏图标。点开宿主用同一个 id 打开面板。 */
    function BridgeIcon(props) {
      const size = props?.size ?? 18
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('rect', { x: 3, y: 4, width: 9, height: 16, rx: 2, stroke: 'currentColor', strokeWidth: 1.6, opacity: 0.45 }),
        h('path', { d: 'M6 8h3M6 11h3', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', opacity: 0.45 }),
        h('rect', { x: 10, y: 7, width: 11, height: 13, rx: 2, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', { d: 'M13 11h5M13 14h3', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
        h('path', { d: 'M16 3.5c2.2.5 3.6 1.9 4 4', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', opacity: 0.7 }),
      )
    }

    /** 面板：显示当前项目状态 + 手工触发按钮。 */
    function BridgePanel(props) {
      const sessionId = typeof props?.session === 'string' && props.session !== '' ? props.session : readSessionId()
      const [state, setState] = React.useState({ loading: true, body: null, error: '' })
      const [busy, setBusy] = React.useState(false)
      const [result, setResult] = React.useState('')

      const reload = React.useCallback(() => {
        setState((current) => ({ ...current, loading: true, error: '' }))
        api(`/plugins/dsh-context-bridge/status?session=${encodeURIComponent(sessionId)}`)
          .then((body) => setState({ loading: false, body, error: '' }))
          .catch((error) => setState({ loading: false, body: null, error: String(error?.message ?? error) }))
      }, [sessionId])

      React.useEffect(() => {
        reload()
      }, [reload])

      const run = React.useCallback(async () => {
        if (busy) return
        setBusy(true)
        setResult('')
        try {
          const body = await api('/plugins/dsh-context-bridge/run', {
            method: 'POST',
            body: JSON.stringify({ session: sessionId }),
          })
          setResult(
            `已建立交接会话 ${body?.sessionId ?? ''}${body?.name ? `（名「${body.name}」）` : ''}：${body?.detail ?? ''}`,
          )
          reload()
          // 交接成功后真正切到新会话
          await revealNewSession(typeof body?.sessionId === 'string' ? body.sessionId : '')
        } catch (error) {
          setResult(`失败：${String(error?.message ?? error)}`)
        } finally {
          setBusy(false)
        }
      }, [busy, reload, sessionId])

      const body = state.body
      const rows = [
        ['项目', body?.projectName ?? '—'],
        ['开关', body?.status ?? (state.loading ? '读取中…' : '—')],
        ['触发', '手动（点按钮才执行）'],
        ['总线名', body?.busName ?? '（未注册）'],
      ]

      return h(
        'div',
        { style: { padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12, font: 'inherit' } },
        h(
          'div',
          { style: { fontSize: 13, opacity: 0.7 } },
          '把当前会话压成交接文档，开一个新会话继续。不会自动触发 —— 上下文快满时先压缩，压不动了再点这里。',
        ),
        state.error !== ''
          ? h('div', { style: { color: '#d66', fontSize: 13 } }, state.error)
          : null,
        h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: '72px 1fr', gap: '6px 10px', fontSize: 13 } },
          ...rows.flatMap(([key, value]) => [
            h('div', { key: `${key}-k`, style: { opacity: 0.6 } }, key),
            h('div', { key: `${key}-v`, style: { minWidth: 0, overflowWrap: 'anywhere' } }, value),
          ]),
        ),
        body?.projectRoot
          ? h('div', { style: { fontSize: 12, opacity: 0.5, overflowWrap: 'anywhere' } }, body.projectRoot)
          : null,
        h(
          'div',
          { style: { display: 'flex', gap: 8 } },
          h(
            'button',
            {
              type: 'button',
              disabled: busy || sessionId === '',
              onClick: () => void run(),
              style: { padding: '6px 12px', cursor: busy ? 'progress' : 'pointer' },
            },
            busy ? '生成中…' : '立即交接',
          ),
          h(
            'button',
            { type: 'button', disabled: state.loading, onClick: () => reload(), style: { padding: '6px 12px' } },
            '刷新状态',
          ),
        ),
        result !== '' ? h('div', { style: { fontSize: 12, opacity: 0.8, overflowWrap: 'anywhere' } }, result) : null,
        h(
          'div',
          { style: { fontSize: 12, opacity: 0.5, lineHeight: 1.7 } },
          '开启方式：在项目根建 .dsh-bridge.json，写 {"enabled": true}。默认关闭，不写文件就完全不工作。',
        ),
      )
    }

    return {
      inject: ['slots', 'uiWorkspace'],
      apply(ctx) {
        const slots = ctx?.slots
        // 交接成功后切换到新会话的宿主能力；openSession(target) —— target 是 session id。
        openSessionInHost = typeof ctx?.uiWorkspace?.openSession === 'function'
          ? (sessionId) => ctx.uiWorkspace.openSession(sessionId)
          : undefined
        if (slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
          return
        }
        try {
          slots.inject('sidebar.workspaces.session.menu.item', () =>
            slots.register({ name: 'sidebar.workspaces.session.menu.item', id: NS, order: 520 }, (props) =>
              h(HandoffMenuItem, props),
            ),
          )
        } catch {
          // slot 不可用就只留面板
        }
        try {
          slots.inject('sidebar.panellist', () =>
            slots.register({ name: 'sidebar.panellist', id: NS, order: 41, label: '上下文交接' }, (props) =>
              h(BridgeIcon, { size: props?.size ?? 18 }),
            ),
          )
        } catch {
          // 忽略
        }
        try {
          slots.inject('main', () =>
            slots.register({ name: 'main', key: NS }, () => h(BridgePanel, {})),
          )
        } catch {
          // 忽略
        }
      },
    }
  },
})
