/**
 * 甘特图插件 — 工作排程与时间线可视化
 *
 * 能力：右键新增工作、可视化甘特图条形图、悬停详情/编辑/删除
 * 数据存储：Supabase（gantt_tasks 表）
 */
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { BarChart3, Plus, ChevronLeft, ChevronRight, X, Pencil, Trash2, Calendar, Flag, Loader2, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

// ============================================================================
// Types
// ============================================================================

interface Task {
  id: string
  name: string
  description: string
  startDate: string
  ddl: string
  color: string       // key into COLOR_HEX
  status: 'pending' | 'in-progress' | 'completed'
  createdAt: string
}

interface TaskRow {
  id: string; user_id: string; name: string; description: string
  start_date: string; ddl: string; color: string; status: string
  created_at: string
}

interface DialogState {
  mode: 'create' | 'edit'
  task?: Task
  defaultStartDate?: string
}

interface ContextMenuState { x: number; y: number; date: string }
interface TooltipState { task: Task; x: number; y: number }

// ============================================================================
// Constants
// ============================================================================

const ROW_HEIGHT = 42
const MIN_BAR_WIDTH = 4
const TOOLTIP_DELAY = 300
const TABLE_NAME = 'gantt_tasks'
const LEFT_WIDTH = 200
// Color keys (stored in DB) → hex values (used as inline styles to avoid Tailwind purge issues)
const COLOR_KEYS = [
  'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5',
  'blue', 'green', 'purple', 'orange', 'pink',
]

const COLOR_HEX: Record<string, string> = {
  'chart-1': '#4cc9f0', 'chart-2': '#4895ef', 'chart-3': '#f72585',
  'chart-4': '#f77f00', 'chart-5': '#06d6a0',
  'blue': '#3b82f6', 'green': '#22c55e', 'purple': '#a855f7',
  'orange': '#f97316', 'pink': '#ec4899',
}

const COLOR_BG: Record<string, string> = {
  'chart-1': 'bg-chart-1', 'chart-2': 'bg-chart-2', 'chart-3': 'bg-chart-3',
  'chart-4': 'bg-chart-4', 'chart-5': 'bg-chart-5',
  'blue': 'bg-blue-500', 'green': 'bg-green-500', 'purple': 'bg-purple-500',
  'orange': 'bg-orange-500', 'pink': 'bg-pink-500',
}

const STATUS_LABELS: Record<Task['status'], string> = {
  'pending': '待开始', 'in-progress': '进行中', 'completed': '已完成',
}

const STATUS_VARIANTS: Record<Task['status'], 'secondary' | 'default' | 'outline'> = {
  'pending': 'secondary', 'in-progress': 'default', 'completed': 'outline',
}

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

// ============================================================================
// Utilities
// ============================================================================

function formatDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function diffDays(a: Date, b: Date): number {
  const va = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime()
  const vb = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime()
  return Math.round((va - vb) / 86400000)
}

function isToday(d: Date): boolean { return formatDate(d) === formatDate(new Date()) }
function isWeekend(d: Date): boolean { const day = d.getDay(); return day === 0 || day === 6 }
function isMonday(d: Date): boolean { return d.getDay() === 1 }

function getMonday(d: Date): Date {
  const date = new Date(d)
  const day = date.getDay()
  date.setDate(date.getDate() + (day === 0 ? -6 : 1 - day))
  return date
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val))
}

function rowToTask(r: TaskRow): Task {
  return {
    id: r.id, name: r.name, description: r.description || '',
    startDate: r.start_date, ddl: r.ddl, color: r.color,
    status: r.status as Task['status'], createdAt: r.created_at,
  }
}

// ============================================================================
// Main Plugin Entry
// ============================================================================

export function register(ctx: any) {
  const { supabase, ui, confirm } = ctx.api

  function getClient() {
    const client = supabase.getClient()
    if (!client) throw new Error('Supabase 未配置')
    return client
  }

  const GanttPage = () => {
    // ---- State ----
    const [tasks, setTasks] = useState<Task[]>([])
    const [loaded, setLoaded] = useState(false)
    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState('')
    const [saving, setSaving] = useState(false)
    const [supabaseOk, setSupabaseOk] = useState(true)
    type ViewMode = 'year' | 'month' | 'day'
    const [viewMode, setViewMode] = useState<ViewMode>('day')
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
    const [tooltip, setTooltip] = useState<TooltipState | null>(null)
    const [dialog, setDialog] = useState<DialogState | null>(null)

    // viewDate: anchor date for current view
    const [viewDate, setViewDate] = useState<Date>(() => {
      const d = new Date(); d.setDate(1); d.setHours(0,0,0,0); return d
    })

    // viewMode → column config
    const viewCfg = useMemo(() => {
      switch (viewMode) {
        case 'year':  return { dayWidth: 72, colsPerUnit: 1, totalCols: 12, scrollAmount: 6, unit: 'month' as const }
        case 'month': return { dayWidth: 24, colsPerUnit: 1, totalCols: 62, scrollAmount: 7, unit: 'day' as const }
        case 'day':   return { dayWidth: 56, colsPerUnit: 1, totalCols: 30, scrollAmount: 3, unit: 'day' as const }
      }
    }, [viewMode])
    const dayWidth = viewCfg.dayWidth

    const scrollRef = useRef<HTMLDivElement>(null)
    const tooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const tooltipDismissRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const contextMenuRef = useRef<HTMLDivElement>(null)
    const tooltipRef = useRef<HTMLDivElement>(null)

    // ---- Derived ----
    const sortedTasks = useMemo(() =>
      [...tasks].sort((a, b) => {
        if (a.startDate !== b.startDate) return a.startDate < b.startDate ? -1 : 1
        return a.createdAt < b.createdAt ? -1 : 1
      }),
    [tasks])

    // Grid start date (day/month mode) or start year (year mode)
    const gridStart = useMemo(() => {
      if (viewMode === 'year') {
        return new Date(viewDate.getFullYear(), 0, 1) // Jan 1 of viewDate's year
      }
      if (tasks.length === 0) return viewDate
      let earliest = viewDate
      tasks.forEach(t => {
        const s = parseDate(t.startDate)
        if (s < earliest) earliest = s
      })
      const d = new Date(earliest); d.setDate(d.getDate() - 7)
      return d < viewDate ? d : viewDate
    }, [tasks, viewDate, viewMode])

    // Total columns in the grid
    const gridTotalCols = useMemo(() => {
      if (viewMode === 'year') return 12 // Jan-Dec
      let latest = gridStart
      tasks.forEach(t => {
        const d = parseDate(t.ddl)
        if (d > latest) latest = d
      })
      return Math.max(viewCfg.totalCols, diffDays(latest, gridStart) + 1 + 14)
    }, [tasks, gridStart, viewMode, viewCfg])

    // Month spans for header (day/month mode only)
    const monthSpans = useMemo(() => {
      const spans: { label: string; cols: number }[] = []
      if (viewMode === 'year') {
        for (let i = 0; i < 12; i++) {
          const d = new Date(gridStart); d.setMonth(d.getMonth() + i)
          spans.push({ label: `${d.getMonth() + 1}月`, cols: 1 })
        }
        return spans
      }
      let cur: { label: string; cols: number } | null = null
      for (let i = 0; i < gridTotalCols; i++) {
        const d = new Date(gridStart); d.setDate(d.getDate() + i)
        const label = `${d.getFullYear()}年${d.getMonth() + 1}月`
        if (cur && cur.label === label) { cur.cols++ }
        else {
          if (cur) spans.push(cur)
          cur = { label, cols: 1 }
        }
      }
      if (cur) spans.push(cur)
      return spans
    }, [gridTotalCols, gridStart, viewMode])

    // Compute bar position for a task
    const barLeft = useCallback((task: Task) => {
      if (viewMode === 'year') {
        const sm = parseDate(task.startDate).getMonth()
        const bm = gridStart.getMonth()
        return (sm - bm + (parseDate(task.startDate).getFullYear() - gridStart.getFullYear()) * 12) * dayWidth
      }
      return diffDays(parseDate(task.startDate), gridStart) * dayWidth
    }, [dayWidth, gridStart, viewMode])

    const barWidth = useCallback((task: Task) => {
      if (viewMode === 'year') {
        const sm = parseDate(task.startDate)
        const em = parseDate(task.ddl)
        const months = (em.getFullYear() - sm.getFullYear()) * 12 + em.getMonth() - sm.getMonth() + 1
        return Math.max(months * dayWidth, MIN_BAR_WIDTH)
      }
      return Math.max((diffDays(parseDate(task.ddl), parseDate(task.startDate)) + 1) * dayWidth, MIN_BAR_WIDTH)
    }, [dayWidth, viewMode])

    // ---- Load tasks ----
    const loadTasks = useCallback(async () => {
      setLoading(true); setLoadError('')
      try {
        const sb = getClient()
        const { data, error } = await sb.from(TABLE_NAME).select('*').order('start_date', { ascending: true })
        if (error) throw error
        setTasks((data as TaskRow[]).map(rowToTask))
      } catch (e: any) {
        if (e.message === 'Supabase 未配置') { setSupabaseOk(false); setLoadError('请先在设置中配置 Supabase 连接') }
        else setLoadError(e.message || '加载任务失败')
      } finally { setLoading(false); setLoaded(true) }
    }, [])

    useEffect(() => {
      if (!supabase?.isConfigured()) { setSupabaseOk(false); setLoadError('请先在设置中配置 Supabase 连接'); setLoading(false); setLoaded(true); return }
      loadTasks()
    }, [supabase, loadTasks])

    // Scroll today into view after mount or viewDate change
    useEffect(() => {
      if (loaded && scrollRef.current) {
        const offset = diffDays(new Date(), gridStart)
        if (offset >= 0 && offset < gridTotalCols) {
          scrollRef.current.scrollLeft = Math.max(0, LEFT_WIDTH + offset * dayWidth - 120)
        }
      }
    }, [loaded, gridStart, dayWidth, gridTotalCols])

    // Reset scroll position when viewDate changes
    useEffect(() => {
      if (loaded && scrollRef.current) {
        scrollRef.current.scrollLeft = 0
      }
    }, [viewDate, loaded])

    // ---- Context menu dismiss ----
    useEffect(() => {
      if (!contextMenu) return
      const dismiss = () => setContextMenu(null)
      const h = (e: MouseEvent) => { if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) dismiss() }
      const k = (e: KeyboardEvent) => { if (e.key === 'Escape') dismiss() }
      document.addEventListener('mousedown', h)
      document.addEventListener('keydown', k)
      window.addEventListener('scroll', dismiss, true)
      return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); window.removeEventListener('scroll', dismiss, true) }
    }, [contextMenu])

    // ---- Tooltip dismiss on scroll ----
    useEffect(() => {
      if (!tooltip) return
      const dismiss = () => setTooltip(null)
      window.addEventListener('scroll', dismiss, true)
      return () => window.removeEventListener('scroll', dismiss, true)
    }, [tooltip])

    // ---- Right-click → date from pixel ----
    const handleContextMenu = useCallback((e: React.MouseEvent) => {
      e.preventDefault()
      const el = scrollRef.current; if (!el) return
      const r = el.getBoundingClientRect()
      const px = e.clientX - r.left + el.scrollLeft - LEFT_WIDTH
      const idx = Math.max(0, Math.floor(px / dayWidth))
      const d = new Date(gridStart); d.setDate(d.getDate() + idx)
      let mx = e.clientX, my = e.clientY
      if (mx + 170 > window.innerWidth) mx = window.innerWidth - 175
      if (my + 50 > window.innerHeight) my = window.innerHeight - 55
      setContextMenu({ x: mx, y: my, date: formatDate(d) })
    }, [gridStart, dayWidth])

    // ---- CRUD ----
    const handleSave = useCallback(async (data: Omit<Task, 'id' | 'createdAt' | 'color'>, editId?: string) => {
      setSaving(true)
      try {
        const sb = getClient()
        if (editId) {
          const { error } = await sb.from(TABLE_NAME).update({
            name: data.name, description: data.description, start_date: data.startDate, ddl: data.ddl, status: data.status,
          }).eq('id', editId)
          if (error) throw error
          setTasks(prev => prev.map(t => t.id === editId ? { ...t, ...data } : t))
          ui.toast('任务已更新', 'success')
        } else {
          // Pick least-used color
          const cnt = new Map<string, number>(); COLOR_KEYS.forEach(c => cnt.set(c, 0))
          tasks.forEach(t => cnt.set(t.color, (cnt.get(t.color) || 0) + 1))
          let best = COLOR_KEYS[0], bestN = Infinity
          cnt.forEach((n, c) => { if (n < bestN) { bestN = n; best = c } })

          const { data: row, error } = await sb.from(TABLE_NAME).insert({
            name: data.name, description: data.description, start_date: data.startDate, ddl: data.ddl,
            color: best, status: data.status,
          }).select().single()
          if (error) throw error
          setTasks(prev => [...prev, rowToTask(row as TaskRow)])
          ui.toast('任务已创建', 'success')
        }
        setDialog(null)
      } catch (e: any) { ui.toast('保存失败: ' + (e.message || 'unknown'), 'error') }
      finally { setSaving(false) }
    }, [tasks, ui])

    const handleDelete = useCallback(async (taskId: string) => {
      const result = await confirm({
        title: '删除任务', message: '确定要删除这个任务吗？此操作不可撤销。',
        actions: [{ key: 'ok', label: '确认删除', variant: 'destructive' }, { key: 'cancel', label: '取消' }],
      })
      if (result !== 'ok') return
      try {
        const sb = getClient()
        const { error } = await sb.from(TABLE_NAME).delete().eq('id', taskId)
        if (error) throw error
        setTasks(prev => prev.filter(t => t.id !== taskId))
        setTooltip(null)
        ui.toast('任务已删除', 'info')
      } catch (e: any) { ui.toast('删除失败: ' + (e.message || 'unknown'), 'error') }
    }, [confirm, ui])

    // ---- Tooltip handlers ----
    const showTooltip = useCallback((task: Task, el: HTMLElement) => {
      if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current)
      if (tooltipDismissRef.current) clearTimeout(tooltipDismissRef.current)
      tooltipTimerRef.current = setTimeout(() => {
        const rect = el.getBoundingClientRect()
        const tw = 280, th = 180
        let tx = rect.left + rect.width / 2 - tw / 2
        // Always show below the bar
        let ty = rect.bottom + 8
        // If not enough room below, fall back to above
        if (ty + th > window.innerHeight - 8) ty = rect.top - th - 8
        tx = clamp(tx, 8, window.innerWidth - tw - 8)
        ty = clamp(ty, 8, window.innerHeight - th - 8)
        setTooltip({ task, x: tx, y: ty })
      }, TOOLTIP_DELAY)
    }, [])

    const hideTooltip = useCallback(() => {
      if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current)
      tooltipDismissRef.current = setTimeout(() => setTooltip(null), 250)
    }, [])

    const cancelHideTooltip = useCallback(() => {
      if (tooltipDismissRef.current) clearTimeout(tooltipDismissRef.current)
    }, [])

    // ---- Navigation ----
    const goToday = useCallback(() => {
      const now = new Date()
      const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
      setViewDate(firstOfMonth)
      // Scroll today into view after render
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          const offset = viewMode === 'year'
            ? now.getMonth()
            : diffDays(now, firstOfMonth)
          scrollRef.current.scrollLeft = Math.max(0, LEFT_WIDTH + offset * dayWidth - 120)
        }
      })
    }, [viewMode, dayWidth])

    // Arrow navigation: change viewDate by one period → full redraw
    const navPrev = useCallback(() => {
      setViewDate(prev => {
        const d = new Date(prev)
        if (viewMode === 'year') d.setFullYear(d.getFullYear() - 1)
        else d.setMonth(d.getMonth() - 1)
        return d
      })
    }, [viewMode])

    const navNext = useCallback(() => {
      setViewDate(prev => {
        const d = new Date(prev)
        if (viewMode === 'year') d.setFullYear(d.getFullYear() + 1)
        else d.setMonth(d.getMonth() + 1)
        return d
      })
    }, [viewMode])

    const switchMode = useCallback((m: ViewMode) => {
      const now = new Date()
      if (m === 'year') setViewDate(new Date(now.getFullYear(), 0, 1))
      else setViewDate(new Date(now.getFullYear(), now.getMonth(), 1))
      setViewMode(m)
    }, [])

    // =====================================================================
    // Render states
    // =====================================================================

    if (loading) {
      return (
        <div className="h-full flex items-center justify-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          <span className="text-sm text-muted-foreground">加载任务数据…</span>
        </div>
      )
    }

    if (!supabaseOk) {
      return (
        <div className="h-full flex flex-col items-center justify-center gap-3 p-8">
          <AlertTriangle className="h-8 w-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">{loadError}</p>
          <p className="text-[11px] text-muted-foreground/50 text-center max-w-xs">甘特图插件需要 Supabase 存储任务数据。请在设置 → 能力中配置 Supabase 连接。</p>
          <Button variant="outline" size="sm" className="h-8 text-xs mt-2" onClick={loadTasks}>重试</Button>
        </div>
      )
    }

    // =====================================================================
    // Sub-components
    // =====================================================================

    const HEADER_H = 52  // month row 18 + day row 34
    const MONTH_H = 18
    const DAY_H = 34

    const TimelineHeader = () => {
      const w = gridTotalCols * dayWidth
      const isYear = viewMode === 'year'
      return (
        <div className="sticky top-0 z-10 bg-card" style={{ width: w }}>
          {/* Month/Year label row */}
          <div className="flex border-b border-border/30" style={{ height: MONTH_H }}>
            {monthSpans.map((ms, i) => (
              <div key={i}
                className="flex items-center justify-center border-r border-border/20 text-[10px] text-muted-foreground font-medium shrink-0"
                style={{ width: ms.cols * dayWidth }}>
                {ms.label}
              </div>
            ))}
          </div>
          {/* Day/Month detail row */}
          <div className="flex border-b border-border" style={{ height: DAY_H }}>
            {isYear ? (
              // Year mode: repeat month number
              Array.from({ length: 12 }, (_, i) => (
                <div key={i}
                  className="flex items-center justify-center shrink-0 border-r border-r-border/20 text-[10px] text-muted-foreground"
                  style={{ width: dayWidth, height: DAY_H }}>
                  {i + 1}
                </div>
              ))
            ) : (
              Array.from({ length: gridTotalCols }, (_, i) => {
                const d = new Date(gridStart); d.setDate(d.getDate() + i)
                const today = isToday(d)
                return (
                  <div key={i}
                    className={cn('flex flex-col items-center justify-center shrink-0 border-r border-r-border/20', today && 'bg-primary/10', isWeekend(d) && !today && 'bg-muted/30')}
                    style={{ width: dayWidth, height: DAY_H }}>
                    <span className={cn('text-[10px] leading-tight', today ? 'text-primary font-semibold' : isWeekend(d) ? 'text-muted-foreground' : 'text-foreground')}>
                      {d.getMonth() + 1}/{d.getDate()}
                    </span>
                    <span className={cn('text-[9px] leading-tight', today ? 'text-primary/60' : 'text-muted-foreground/50')}>
                      {WEEKDAY_LABELS[d.getDay()]}
                    </span>
                  </div>
                )
              })
            )}
          </div>
        </div>
      )
    }

    const TaskBar = ({ task }: { task: Task }) => {
      const left = barLeft(task)
      const bw = barWidth(task)
      const overdue = parseDate(task.ddl) < new Date() && task.status !== 'completed'
      const hex = COLOR_HEX[task.color] || '#4895ef'

      return (
        <div
          className={cn('absolute rounded flex items-center gap-1 cursor-pointer transition-shadow hover:shadow-lg group', overdue && 'ring-2 ring-destructive ring-offset-1 ring-offset-background')}
          style={{
            left, top: 5, width: bw, height: ROW_HEIGHT - 10, minWidth: MIN_BAR_WIDTH,
            backgroundColor: hex, opacity: task.status === 'completed' ? 0.45 : 1,
          }}
          onMouseEnter={(e) => showTooltip(task, e.currentTarget as HTMLElement)}
          onMouseLeave={hideTooltip}
        >
          {bw > 40 && (
            <span className={cn('text-[11px] text-white font-medium truncate px-2', task.status === 'completed' && 'line-through')}>
              {task.name}
            </span>
          )}
        </div>
      )
    }

    const TimelineBody = () => (
      <div style={{ width: gridTotalCols * dayWidth }} onContextMenu={handleContextMenu}>
        {sortedTasks.length === 0 ? (
          <div className="flex items-center justify-center text-xs text-muted-foreground/40 select-none border-b border-border/20" style={{ height: ROW_HEIGHT }}>右键此处新增工作</div>
        ) : (
          sortedTasks.map(task => (
            <div key={task.id} className="relative border-b border-border/20" style={{ height: ROW_HEIGHT }}>
              <TaskBar task={task} />
            </div>
          ))
        )}
      </div>
    )

    // Grid drawn once behind bars
    const GridOverlay = () => (
      <div className="absolute inset-0 pointer-events-none">
        <div style={{ width: gridTotalCols * dayWidth, height: '100%' }}>
          {Array.from({ length: gridTotalCols }, (_, i) => {
            const d = new Date(gridStart); d.setDate(d.getDate() + i)
            return (
              <div key={i}
                className={cn('absolute top-0 bottom-0 border-r border-r-border/10', isToday(d) && 'bg-primary/[0.03]', isWeekend(d) && !isToday(d) && 'bg-muted/10')}
                style={{ left: i * dayWidth, width: dayWidth }} />
            )
          })}
        </div>
      </div>
    )

    const LeftRows = () => (
      <>
        {sortedTasks.length === 0 ? (
          <div className="flex items-center px-3 text-[11px] text-muted-foreground/40 border-b border-border/20" style={{ height: ROW_HEIGHT }}>暂无任务</div>
        ) : (
          sortedTasks.map(task => (
            <div key={task.id} className="flex items-center gap-2 px-3 border-b border-border/20 bg-card" style={{ height: ROW_HEIGHT }}>
              <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: COLOR_HEX[task.color] || '#4895ef' }} />
              <span className={cn('text-[12px] truncate flex-1', task.status === 'completed' && 'line-through text-muted-foreground')}>{task.name}</span>
              <Badge variant={STATUS_VARIANTS[task.status]} className="text-[9px] px-1 py-0 h-4 shrink-0">{STATUS_LABELS[task.status]}</Badge>
            </div>
          ))
        )}
      </>
    )

    const ContextMenuPopup = () => (
      <div ref={contextMenuRef}
        className="fixed z-[100] min-w-[160px] rounded-lg border border-border bg-card shadow-xl py-1"
        style={{ left: contextMenu!.x, top: contextMenu!.y }}>
        <div className="px-2 py-1 text-[10px] text-muted-foreground border-b border-border/50 mb-1">{contextMenu!.date}</div>
        <button className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] hover:bg-accent transition-colors text-left"
          onClick={() => { const d = contextMenu!.date; setContextMenu(null); setDialog({ mode: 'create', defaultStartDate: d }) }}>
          <Plus className="h-3.5 w-3.5" />新增工作
        </button>
      </div>
    )

    const TaskFormDialog = ({ dialog }: { dialog: DialogState }) => {
      const edit = dialog.mode === 'edit' ? dialog.task : null
      const [name, setName] = useState(edit?.name || '')
      const [desc, setDesc] = useState(edit?.description || '')
      const [startDate, setStartDate] = useState(edit?.startDate || dialog.defaultStartDate || formatDate(new Date()))
      const [ddl, setDdl] = useState(edit?.ddl || formatDate(new Date(new Date().setDate(new Date().getDate() + 7))))
      const [status, setStatus] = useState<Task['status']>(edit?.status || 'pending')
      const [errors, setErrors] = useState<Record<string, string>>({})

      const validate = () => {
        const e: Record<string, string> = {}
        if (!name.trim()) e.name = '请输入任务名称'
        if (parseDate(ddl) < parseDate(startDate)) e.ddl = '截止日期不能早于开始日期'
        setErrors(e); return Object.keys(e).length === 0
      }

      const submit = () => {
        if (!validate()) return
        handleSave({ name: name.trim(), description: desc.trim(), startDate, ddl, status }, edit?.id)
      }

      const inputCls = (hasErr: boolean) =>
        `w-full rounded-md border bg-background px-3 py-1.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring ${hasErr ? 'border-destructive' : 'border-input'}`

      return (
        <div data-backdrop="true"
          style={{ position: 'fixed', inset: 0, zIndex: 50, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32 }}
          onClick={(ev) => { if ((ev.target as HTMLElement).dataset.backdrop === 'true') setDialog(null) }}
          onKeyDown={(ev) => { if (ev.key === 'Escape') setDialog(null) }}>
          <div style={{ backgroundColor: 'hsl(var(--card))', borderRadius: 10, border: '1px solid hsl(var(--border))', boxShadow: '0 10px 40px rgba(0,0,0,0.2)', width: 380, maxHeight: '90vh', overflowY: 'auto' }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 24px', borderBottom: '1px solid hsl(var(--border))' }}>
              <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>{dialog.mode === 'create' ? '新增工作' : '编辑工作'}</h3>
              <button style={{ width: 20, height: 20, borderRadius: 4, border: 'none', background: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setDialog(null)}><X size={14} color="hsl(var(--muted-foreground))" /></button>
            </div>
            {/* Body */}
            <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 11, fontWeight: 500, color: 'hsl(var(--muted-foreground))' }}>任务名称</span>
                <input
                  placeholder="输入任务名称" value={name}
                  onChange={(e: any) => { setName(e.target.value); setErrors(prev => ({ ...prev, name: '' })) }}
                  className={inputCls(!!errors.name)}
                  autoFocus
                  onKeyDown={(e: any) => { if (e.key === 'Enter') submit() }} />
                {errors.name && <span style={{ fontSize: 10, color: 'hsl(var(--destructive))' }}>{errors.name}</span>}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 11, fontWeight: 500, color: 'hsl(var(--muted-foreground))' }}>描述</span>
                <textarea placeholder="任务描述（可选）" value={desc} onChange={(e: any) => setDesc(e.target.value)} rows={2}
                  className={inputCls(false)} style={{ resize: 'vertical' }} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 11, fontWeight: 500, color: 'hsl(var(--muted-foreground))' }}>开始</span>
                  <input type="date" value={startDate} onChange={(e: any) => setStartDate(e.target.value)} className={inputCls(false)} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 11, fontWeight: 500, color: 'hsl(var(--muted-foreground))' }}>截止</span>
                  <input type="date" value={ddl}
                    onChange={(e: any) => { setDdl(e.target.value); setErrors(prev => ({ ...prev, ddl: '' })) }}
                    className={inputCls(!!errors.ddl)} />
                  {errors.ddl && <span style={{ fontSize: 10, color: 'hsl(var(--destructive))' }}>{errors.ddl}</span>}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 11, fontWeight: 500, color: 'hsl(var(--muted-foreground))' }}>状态</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  {(['pending', 'in-progress', 'completed'] as Task['status'][]).map(s => (
                    <button key={s} type="button"
                      onClick={() => setStatus(s)}
                      style={{
                        flex: 1, height: 28, borderRadius: 6, fontSize: 11, fontWeight: 500, border: '1px solid',
                        cursor: 'pointer', transition: 'all 0.15s',
                        ...(status === s ? {
                          backgroundColor: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))', borderColor: 'hsl(var(--primary))',
                        } : {
                          backgroundColor: 'hsl(var(--background))', color: 'hsl(var(--muted-foreground))', borderColor: 'hsl(var(--input))',
                        }),
                      }}
                    >{STATUS_LABELS[s]}</button>
                  ))}
                </div>
              </div>
            </div>
            {/* Footer */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '14px 24px', borderTop: '1px solid hsl(var(--border))', borderBottomLeftRadius: 10, borderBottomRightRadius: 10 }}>
              <Button variant="ghost" size="sm" className="h-7 text-[11px] px-3" onClick={() => setDialog(null)} disabled={saving}>取消</Button>
              <Button size="sm" className="h-7 text-[11px] px-4" onClick={submit} disabled={saving}>
                {saving && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
                {saving ? '保存中…' : dialog.mode === 'create' ? '创建' : '保存'}
              </Button>
            </div>
          </div>
        </div>
      )
    }

    const TaskTooltipPopup = ({ tooltip }: { tooltip: TooltipState }) => {
      const { task } = tooltip
      const overdue = parseDate(task.ddl) < new Date() && task.status !== 'completed'
      const hex = COLOR_HEX[task.color] || '#4895ef'

      return (
        <div ref={tooltipRef}
          className="fixed z-[100] w-[280px] rounded-lg border border-border bg-card shadow-xl p-4 space-y-3"
          style={{ left: tooltip.x, top: tooltip.y }}
          onMouseEnter={cancelHideTooltip}
          onMouseLeave={() => setTooltip(null)}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: hex }} />
              <h4 className="text-[13px] font-semibold truncate">{task.name}</h4>
            </div>
            <button className="h-5 w-5 rounded hover:bg-accent flex items-center justify-center shrink-0 ml-2" onClick={() => setTooltip(null)}><X className="h-3 w-3 text-muted-foreground" /></button>
          </div>
          {task.description && <p className="text-[11px] text-muted-foreground leading-relaxed">{task.description}</p>}
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-[11px]"><Calendar className="h-3 w-3 text-muted-foreground shrink-0" /><span className="text-muted-foreground">开始：</span><span>{task.startDate}</span></div>
            <div className="flex items-center gap-2 text-[11px]"><Flag className="h-3 w-3 text-muted-foreground shrink-0" /><span className="text-muted-foreground">截止：</span><span className={cn(overdue && 'text-destructive font-medium')}>{task.ddl}{overdue && ' (已逾期)'}</span></div>
            <Badge variant={STATUS_VARIANTS[task.status]} className="text-[9px] px-1 py-0 h-4">{STATUS_LABELS[task.status]}</Badge>
          </div>
          <div className="flex gap-2 pt-1">
            <Button variant="outline" size="sm" className="h-7 text-[11px] flex-1" onClick={() => { setTooltip(null); setDialog({ mode: 'edit', task }) }}><Pencil className="h-3 w-3 mr-1" />编辑</Button>
            <Button variant="destructive" size="sm" className="h-7 text-[11px] flex-1" onClick={() => handleDelete(task.id)}><Trash2 className="h-3 w-3 mr-1" />删除</Button>
          </div>
        </div>
      )
    }

    const TitleBar = () => {
      const modes: { key: ViewMode; label: string }[] = [
        { key: 'year', label: '年' },
        { key: 'month', label: '月' },
        { key: 'day', label: '日' },
      ]
      return (
        <div className="flex items-center gap-3 px-4 py-1.5 border-b border-border bg-card shrink-0" style={{ height: 41 }}>
          <BarChart3 className="h-4 w-4 text-muted-foreground shrink-0" />
          <h1 className="text-sm font-semibold">甘特图</h1>
          <span className="text-[10px] text-muted-foreground">{tasks.length} 任务</span>

          <div className="flex-1" />

          {/* View mode switcher */}
          <div className="flex rounded-md border border-border overflow-hidden">
            {modes.map((m, i) => (
              <button key={m.key}
                className={cn('px-2.5 py-1 text-[11px] font-medium transition-colors',
                  i > 0 && 'border-l border-border',
                  viewMode === m.key ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-accent',
                )}
                onClick={() => switchMode(m.key)}>{m.label}</button>
            ))}
          </div>

          <Button variant="outline" size="sm" className="h-7 text-[11px] px-2" onClick={goToday}>今天</Button>

          <Button size="sm" className="h-7 text-[11px] px-3" onClick={() => setDialog({ mode: 'create', defaultStartDate: formatDate(new Date()) })}>
            <Plus className="h-3.5 w-3.5 mr-1" />新增工作
          </Button>
        </div>
      )
    }

    // =====================================================================
    // Main
    // =====================================================================

    return (
      <div className="h-full flex flex-col bg-background select-none">
        <TitleBar />
        <div className="flex flex-1 overflow-hidden relative">
          {/* Scroll area */}
          <div ref={scrollRef} className="flex-1 overflow-auto">
            <div className="flex" style={{ minWidth: LEFT_WIDTH + gridTotalCols * dayWidth, minHeight: '100%' }}>
              {/* Left panel */}
              <div className="sticky left-0 z-40 bg-card" style={{ width: LEFT_WIDTH, boxShadow: '1px 0 0 0 hsl(var(--border)), 2px 0 4px rgba(0,0,0,0.05)' }}>
                <div className="sticky top-0 z-40 bg-card border-b border-border px-3 flex items-center" style={{ height: HEADER_H }}>
                  <span className="text-[11px] font-semibold text-muted-foreground">任务名称</span>
                  <span className="ml-auto text-[10px] text-muted-foreground/50">{tasks.length}</span>
                </div>
                <LeftRows />
              </div>
              {/* Timeline */}
              <div className="flex-1 relative" style={{ minWidth: gridTotalCols * dayWidth }}>
                <GridOverlay />
                <TimelineHeader />
                <TimelineBody />
              </div>
            </div>
          </div>

          {/* Left arrow — fixed at boundary between panel and timeline */}
          <button className="absolute z-50 w-6 h-10 rounded-r border border-border bg-card shadow flex items-center justify-center hover:bg-accent transition-colors"
            style={{ left: LEFT_WIDTH, top: '50%', transform: 'translateY(-50%)' }}
            onClick={navPrev} title="上一周期">
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>

          {/* Right arrow — outside scroll area */}
          <button className="shrink-0 w-7 border-l border-border bg-card flex items-center justify-center hover:bg-accent transition-colors group"
            onClick={navNext} title="下一周期">
            <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground" />
          </button>
        </div>
        {contextMenu && <ContextMenuPopup />}
        {dialog && <TaskFormDialog dialog={dialog} />}
        {tooltip && <TaskTooltipPopup tooltip={tooltip} />}
      </div>
    )
  }

  ctx.registerNav({ id: 'gantt', label: '甘特图', icon: 'BarChart3', order: 80 })
  ctx.registerRoute('gantt', () => Promise.resolve({ default: GanttPage }))

  // ---- AI 工具（只读） ----
  ctx.onToolRegister((tools: Record<string, any>) => {
    function getSB() {
      const client = supabase.getClient()
      if (!client) throw new Error('Supabase 未配置')
      return client
    }

    tools['gantt_list'] = {
      description: '查询甘特图任务列表。可按日期范围、状态筛选。不传参数时返回全部。返回 id、名称、日期、状态等摘要。需要查看某个任务描述时用 gantt_get。',
      inputSchema: {
        type: 'object',
        properties: {
          date_from: { type: 'string', description: '开始日期 YYYY-MM-DD（可选）' },
          date_to: { type: 'string', description: '截止日期 YYYY-MM-DD（可选）' },
          status: { type: 'string', description: 'pending / in-progress / completed' },
        },
      },
      execute: async (args: { date_from?: string; date_to?: string; status?: string }) => {
        try {
          const sb = getSB()
          let q = sb.from('gantt_tasks').select('id,name,start_date,ddl,color,status').order('start_date', { ascending: true })
          if (args.date_from) q = q.gte('start_date', args.date_from)
          if (args.date_to) q = q.lte('ddl', args.date_to)
          if (args.status) q = q.eq('status', args.status)
          const { data, error } = await q
          if (error) throw error
          const rows = (data || []) as any[]
          if (!rows.length) return '没有匹配的任务。'
          return rows.map((t: any) =>
            `- ${t.name} (${t.id.slice(0, 8)}) | ${t.start_date} → ${t.ddl} | ${t.status}${t.ddl < formatDate(new Date()) && t.status !== 'completed' ? ' ⚠️逾期' : ''}`
          ).join('\n')
        } catch (e: any) { return '查询失败: ' + e.message }
      },
    }

    tools['gantt_get'] = {
      description: '按 id 获取任务完整详情（含描述）。先用 gantt_list 拿到 id，再用此工具。',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: '任务 id，支持前 8 位短 id' } },
        required: ['id'],
      },
      execute: async (args: { id: string }) => {
        try {
          const sb = getSB()
          let q = sb.from('gantt_tasks').select('*')
          q = args.id.length < 36 ? q.filter('id::text', 'like', `${args.id}%`) : q.eq('id', args.id)
          const { data, error } = await q.maybeSingle()
          if (error) throw error
          if (!data) return `未找到 id=${args.id} 的任务。`
          const t = data as any
          const overdue = t.ddl < formatDate(new Date()) && t.status !== 'completed'
          return `## ${t.name}\n\n${t.description || '(无描述)'}\n\n- 开始: ${t.start_date}\n- 截止: ${t.ddl}${overdue ? ' (已逾期)' : ''}\n- 状态: ${t.status}`
        } catch (e: any) { return '查询失败: ' + e.message }
      },
    }
  })
}
