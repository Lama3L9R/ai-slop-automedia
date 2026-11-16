import { A, Route, Router, type RouteSectionProps } from '@solidjs/router'
import { Show, createSignal } from 'solid-js'
import { api, password, setPassword } from './api'
import MediaDetailPage from './pages/MediaDetail'
import MediaListPage from './pages/MediaList'
import SettingsPage from './pages/Settings'
import SourcesPage from './pages/Sources'
import WizardPage from './pages/Wizard'
import { Toasts, useAction } from './ui'

function Login() {
  const [value, setValue] = createSignal('')
  const [error, setError] = createSignal('')
  const [submit, busy] = useAction(async () => {
    setError('')
    try {
      await api('/auth/check', { auth: value() })
      setPassword(value())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  })
  return (
    <div class="flex min-h-screen items-center justify-center p-4">
      <form
        class="card w-full max-w-sm p-6"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <h1 class="mb-1 text-lg font-semibold">automedia</h1>
        <p class="mb-4 text-xs text-slate-500">
          输入访问密码。首次启动时密码会打印在服务端终端里，并保存在 data/password.txt。
        </p>
        <input
          class="input mb-3"
          type="password"
          autofocus
          placeholder="访问密码"
          value={value()}
          onInput={(e) => setValue(e.currentTarget.value)}
        />
        <Show when={error()}>
          <p class="mb-3 text-xs text-red-600">{error()}</p>
        </Show>
        <button class="btn btn-primary w-full" disabled={busy() || !value()}>
          进入
        </button>
      </form>
    </div>
  )
}

function Layout(props: RouteSectionProps) {
  const link = 'rounded-md px-3 py-1.5 text-slate-600 hover:bg-slate-100'
  return (
    <div class="min-h-screen">
      <header class="sticky top-0 z-30 border-b border-slate-200 bg-white">
        <nav class="mx-auto flex max-w-7xl items-center gap-1 px-4 py-2">
          <span class="mr-4 font-semibold">automedia</span>
          <A href="/" end class={link} activeClass="bg-slate-100 font-medium text-slate-900">
            媒体
          </A>
          <A href="/sources" class={link} activeClass="bg-slate-100 font-medium text-slate-900">
            来源
          </A>
          <A href="/settings" class={link} activeClass="bg-slate-100 font-medium text-slate-900">
            设置
          </A>
          <button class="btn btn-sm ml-auto" onClick={() => setPassword('')}>
            退出
          </button>
        </nav>
      </header>
      <main class="mx-auto max-w-7xl px-4 py-4">{props.children}</main>
    </div>
  )
}

export default function App() {
  return (
    <>
      <Show when={password()} fallback={<Login />}>
        <Router root={Layout}>
          <Route path="/" component={MediaListPage} />
          <Route path="/media/:id" component={MediaDetailPage} />
          <Route path="/sources" component={SourcesPage} />
          <Route path="/import" component={WizardPage} />
          <Route path="/settings" component={SettingsPage} />
        </Router>
      </Show>
      <Toasts />
    </>
  )
}
