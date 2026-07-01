/**
 * 甘特图插件 — 工作排程与时间线可视化
 *
 * 能力：右键新增工作、可视化甘特图条形图、悬停详情/编辑/删除
 * 数据存储：Supabase（gantt_tasks 表）
 */
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { BarChart3, Plus, ChevronLeft, ChevronRight, X, Pencil, Trash2, Calendar, Flag, ZoomIn, ZoomOut, Loader2, AlertTriangle, GripHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
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
  color: string
  status: 'pending' | 'in-progress' | 'completed'
  createdAt: string
}

interface TaskRow {
  id: string
  user_id: string
  name: string
  description: string
  start_date: string
  ddl: string
  color: string
  status: string
  created_at: string
}

interface DialogState {
  mode: 'create' | 'edit'
  task?: Task
  defaultStartDate?: string
}

interface ContextMenuState {
  x: number
  y: number
  date: string
}

interface TooltipState {
  task: Task
  x: number
  y: number
}

// ============================================================================
// Constants
// ============================================================================

const DAY_WIDTH = 56
const ROW_HEIGHT = 42
const MIN_BAR_WIDTH = 4
const TOOLTIP_DELAY = 300
const TABLE_NAME = 'gantt_tasks'

const COLORS = [
  'bg-chart-1', 'bg-chart-2', 'bg-chart-3', 'bg-chart-4', 'bg-chart-5',
  'bg-blue-500', 'bg-green-500', 'bg-purple-500', 'bg-orange-500', 'bg-pink-500',
]

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

function isToday(d: Date): boolean {
  return formatDate(d) === formatDate(new Date())
}

function isWeekend(d: Date): boolean {
  const day = d.getDay()
  return day === 0 || day === 6
}

function isMonday(d: Date): boolean {
  return d.getDay() === 1
}

function getMonday(d: Date): Date {
  const date = new Date(d)
  const day = date.getDay()
  const diff = day === 0 ? -6 : 1 - day
  date.setDate(date.getDate() + diff)
  return date
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val))
}

function rowToTask(r: TaskRow): Task {
  return {
    id: r.id,
    name: r.name,
    description: r.description || '',
    startDate: r.start_date,
    ddl: r.ddl,
    color: r.color,
    status: r.status as Task['status'],
    createdAt: r.created_at,
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
    const [daysToShow, setDaysToShow] = useState(21)
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
    const [tooltip, setTooltip] = useState<TooltipState | null>(null)
    const [dialog, setDialog] = useState<DialogState | null>(null)

    // Anchor date: fixed, never changes after mount
    const anchorDateRef = useRef<Date>(getMonday(new Date()))

    const scrollRef = useRef<HTMLDivElement>(null)
    const leftPanelRef = useRef<HTMLDivElement>(null)
    const syncScrollRef = useRef(false)
    const tooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const tooltipDismissRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const contextMenuRef = useRef<HTMLDivElement>(null)
    const tooltipRef = useRef<HTMLDivElement>(null)
    const titleBarHeight = 41

    // ---- Derived ----
    const anchorDate = anchorDateRef.current

    // Total grid days: cover all tasks (from anchor to latest ddl + 14 days padding), minimum = daysToShow
    const totalDays = useMemo(() => {
      if (tasks.length === 0) return daysToShow
      let latest = anchorDate
      tasks.forEach(t => {
        const d = parseDate(t.ddl)
        if (d > latest) latest = d
      })
      const fromAnchor = diffDays(latest, anchorDate) + 1 + 14
      return Math.max(daysToShow, fromAnchor)
    }, [tasks, daysToShow, anchorDate])

    const sortedTasks = useMemo(() =>
      [...tasks].sort((a, b) => {
        if (a.startDate !== b.startDate) return a.startDate < b.startDate ? -1 : 1
        return a.createdAt < b.createdAt ? -1 : 1
      }),
    [tasks])

    // Day offset for a date relative to anchor
    const dayOffset = useCallback((dateStr: string) => {
      return diffDays(parseDate(dateStr), anchorDate)
    }, [anchorDate])

    // ---- Load tasks ----
    const loadTasks = useCallback(async () => {
      setLoading(true)
      setLoadError('')
      try {
        const sb = getClient()
        const { data, error } = await sb.from(TABLE_NAME).select('*').order('start_date', { ascending: true })
        if (error) throw error
        setTasks((data as TaskRow[]).map(rowToTask))
      } catch (e: any) {
        if (e.message === 'Supabase 未配置') {
          setSupabaseOk(false)
          setLoadError('请先在设置中配置 Supabase 连接')
        } else {
          setLoadError(e.message || '加载任务失败')
        }
      } finally {
        setLoading(false)
        setLoaded(true)
      }
    }, [])

    useEffect(() => {
      if (!supabase?.isConfigured()) {
        setSupabaseOk(false)
        setLoadError('请先在设置中配置 Supabase 连接')
        setLoading(false)
        setLoaded(true)
        return
      }
      loadTasks()
    }, [supabase, loadTasks])

    // Scroll to today on mount
    useEffect(() => {
      if (loaded && scrollRef.current) {
        const todayOffset = diffDays(new Date(), anchorDate)
        if (todayOffset >= 0) {
          scrollRef.current.scrollLeft = Math.max(0, todayOffset * DAY_WIDTH - 80)
        }
      }
    }, [loaded, anchorDate])

    // ---- Scroll sync ----
    const handleLeftScroll = useCallback(() => {
      if (syncScrollRef.current) return
      syncScrollRef.current = true
      if (leftPanelRef.current && scrollRef.current) {
        scrollRef.current.scrollTop = leftPanelRef.current.scrollTop
      }
      requestAnimationFrame(() => { syncScrollRef.current = false })
    }, [])

    const handleMainScroll = useCallback(() => {
      if (syncScrollRef.current) return
      syncScrollRef.current = true
      if (leftPanelRef.current && scrollRef.current) {
        leftPanelRef.current.scrollTop = scrollRef.current.scrollTop
      }
      requestAnimationFrame(() => { syncScrollRef.current = false })
    }, [])

    // ---- Context menu dismiss ----
    useEffect(() => {
      if (!contextMenu) return
      const dismiss = () => setContextMenu(null)
      const handleClick = (e: MouseEvent) => {
        if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) dismiss()
      }
      document.addEventListener('mousedown', handleClick)
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') dismiss() })
      window.addEventListener('scroll', dismiss, true)
      return () => {
        document.removeEventListener('mousedown', handleClick)
        document.removeEventListener('keydown', () => {})
        window.removeEventListener('scroll', dismiss, true)
      }
    }, [contextMenu])

    // ---- Tooltip dismiss on scroll ----
    useEffect(() => {
      if (!tooltip) return
      const dismiss = () => setTooltip(null)
      window.addEventListener('scroll', dismiss, true)
      return () => window.removeEventListener('scroll', dismiss, true)
    }, [tooltip])

    // ---- Right-click: calculate date from click position ----
    const handleContextMenu = useCallback((e: React.MouseEvent) => {
      e.preventDefault()
      const container = scrollRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      const clickX = e.clientX - rect.left + container.scrollLeft
      const dayIdx = Math.floor(clickX / DAY_WIDTH)
      const d = new Date(anchorDate)
      d.setDate(d.getDate() + dayIdx)
      let mx = e.clientX, my = e.clientY
      if (mx + 170 > window.innerWidth) mx = window.innerWidth - 175
      if (my + 50 > window.innerHeight) my = window.innerHeight - 55
      setContextMenu({ x: mx, y: my, date: formatDate(d) })
    }, [anchorDate])

    // ---- CRUD ----
    const handleSave = useCallback(async (data: Omit<Task, 'id' | 'createdAt' | 'color'>, editId?: string) => {
      setSaving(true)
      try {
        const sb = getClient()
        if (editId) {
          const { error } = await sb.from(TABLE_NAME).update({
            name: data.name, description: data.description,
            start_date: data.startDate, ddl: data.ddl, status: data.status,
          }).eq('id', editId)
          if (error) throw error
          setTasks(prev => prev.map(t => t.id === editId ? { ...t, ...data } : t))
          ui.toast('任务已更新', 'success')
        } else {
          const colorCounts = new Map<string, number>()
          COLORS.forEach(c => colorCounts.set(c, 0))
          tasks.forEach(t => colorCounts.set(t.color, (colorCounts.get(t.color) || 0) + 1))
          let bestColor = COLORS[0]; let bestCount = Infinity
          colorCounts.forEach((cnt, col) => { if (cnt < bestCount) { bestCount = cnt; bestColor = col } })

          const { data: inserted, error } = await sb.from(TABLE_NAME).insert({
            name: data.name, description: data.description,
            start_date: data.startDate, ddl: data.ddl,
            color: bestColor, status: data.status,
          }).select().single()
          if (error) throw error
          setTasks(prev => [...prev, rowToTask(inserted as TaskRow)])
          ui.toast('任务已创建', 'success')
        }
        setDialog(null)
      } catch (e: any) {
        ui.toast('保存失败: ' + (e.message || 'unknown'), 'error')
      } finally { setSaving(false) }
    }, [tasks, ui])

    const handleDelete = useCallback(async (taskId: string) => {
      const result = await confirm({
        title: '删除任务',
        message: '确定要删除这个任务吗？此操作不可撤销。',
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
      } catch (e: any) {
        ui.toast('删除失败: ' + (e.message || 'unknown'), 'error')
      }
    }, [confirm, ui])

    // ---- Tooltip handlers ----
    const showTooltip = useCallback((task: Task, el: HTMLElement) => {
      if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current)
      if (tooltipDismissRef.current) clearTimeout(tooltipDismissRef.current)
      tooltipTimerRef.current = setTimeout(() => {
        const rect = el.getBoundingClientRect()
        const tw = 280, th = 200
        let tx = rect.left + rect.width / 2 - tw / 2
        let ty = rect.top - th - 8
        if (ty < 8) ty = rect.bottom + 8
        if (tx < 8) tx = 8
        if (tx + tw > window.innerWidth) tx = window.innerWidth - tw - 8
        if (ty + th > window.innerHeight) ty = window.innerHeight - th - 8
        setTooltip({ task, x: tx, y: ty })
      }, TOOLTIP_DELAY)
    }, [])

    const hideTooltip = useCallback(() => {
      if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current)
      tooltipDismissRef.current = setTimeout(() => setTooltip(null), 200)
    }, [])

    const cancelHideTooltip = useCallback(() => {
      if (tooltipDismissRef.current) clearTimeout(tooltipDismissRef.current)
    }, [])

    // ---- Navigation ----
    const goToday = useCallback(() => {
      if (scrollRef.current) {
        const offset = diffDays(new Date(), anchorDate)
        scrollRef.current.scrollTo({ left: Math.max(0, offset * DAY_WIDTH - 100), behavior: 'smooth' })
      }
    }, [anchorDate])

    const panLeft = useCallback(() => {
      if (scrollRef.current) scrollRef.current.scrollBy({ left: -400, behavior: 'smooth' })
    }, [])

    const panRight = useCallback(() => {
      if (scrollRef.current) scrollRef.current.scrollBy({ left: 400, behavior: 'smooth' })
    }, [])

    const zoomIn = useCallback(() => setDaysToShow(d => clamp(d - 7, 7, 42)), [])
    const zoomOut = useCallback(() => setDaysToShow(d => clamp(d + 7, 7, 42)), [])

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
          <p className="text-[11px] text-muted-foreground/50 max-w-xs text-center">
            甘特图插件需要 Supabase 存储任务数据。请在设置 → 能力中配置 Supabase 连接。
          </p>
          <Button variant="outline" size="sm" className="h-8 text-xs mt-2" onClick={loadTasks}>重试</Button>
        </div>
      )
    }

    // =====================================================================
    // Sub-components
    // =====================================================================

    const TimelineHeader = () => (
      <div
        className="sticky top-0 z-10 bg-card flex border-b border-border"
        style={{ width: totalDays * DAY_WIDTH, minWidth: '100%' }}
      >
        {Array.from({ length: totalDays }, (_, i) => {
          const d = new Date(anchorDate)
          d.setDate(d.getDate() + i)
          const today = isToday(d)
          const weekend = isWeekend(d)
          const mon = isMonday(d)
          return (
            <div
              key={i}
              className={cn(
                'flex flex-col items-center justify-center shrink-0 border-r',
                mon ? 'border-r-border/40' : 'border-r-border/15',
                today ? 'bg-primary/10' : weekend ? 'bg-muted/30' : '',
              )}
              style={{ width: DAY_WIDTH, height: 34 }}
            >
              <span className={cn('text-[10px] leading-tight', today ? 'text-primary font-semibold' : weekend ? 'text-muted-foreground' : 'text-foreground')}>
                {d.getMonth() + 1}/{d.getDate()}
              </span>
              <span className={cn('text-[9px] leading-tight', today ? 'text-primary/60' : 'text-muted-foreground/50')}>
                {WEEKDAY_LABELS[d.getDay()]}
              </span>
            </div>
          )
        })}
      </div>
    )

    const TaskBar = ({ task }: { task: Task }) => {
      const left = dayOffset(task.startDate) * DAY_WIDTH
      const barW = Math.max((diffDays(parseDate(task.ddl), parseDate(task.startDate)) + 1) * DAY_WIDTH, MIN_BAR_WIDTH)
      const overdue = parseDate(task.ddl) < new Date() && task.status !== 'completed'
      const isShort = barW < 60

      return (
        <div
          className={cn(
            'absolute rounded flex items-center gap-1 cursor-pointer transition-shadow hover:shadow-lg group',
            task.color,
            task.status === 'completed' ? 'opacity-50' : '',
            overdue ? 'ring-2 ring-destructive ring-offset-1 ring-offset-background' : '',
          )}
          style={{ left, top: 5, width: barW, height: ROW_HEIGHT - 10, minWidth: MIN_BAR_WIDTH }}
          onMouseEnter={(e) => showTooltip(task, e.currentTarget as HTMLElement)}
          onMouseLeave={hideTooltip}
        >
          {!isShort && (
            <span className={cn('text-[11px] text-white font-medium truncate px-2', task.status === 'completed' ? 'line-through opacity-70' : '')}>
              {task.name}
            </span>
          )}
          {isShort && barW > 10 && <div className="w-full h-full" />}
        </div>
      )
    }

    const TimelineBody = () => (
      <div
        style={{ width: totalDays * DAY_WIDTH, minWidth: '100%' }}
        onContextMenu={handleContextMenu}
      >
        {sortedTasks.length === 0 ? (
          <div
            className="flex items-center justify-center text-xs text-muted-foreground/40 select-none"
            style={{ height: ROW_HEIGHT }}
            onContextMenu={handleContextMenu}
          >
            右键此处新增工作
          </div>
        ) : (
          sortedTasks.map(task => (
            <div
              key={task.id}
              className="relative border-b border-border/20"
              style={{ height: ROW_HEIGHT }}
              onContextMenu={handleContextMenu}
            >
              {/* Grid columns */}
              {Array.from({ length: totalDays }, (_, i) => {
                const d = new Date(anchorDate)
                d.setDate(d.getDate() + i)
                return (
                  <div
                    key={i}
                    className={cn(
                      'absolute top-0 bottom-0 border-r border-r-border/10',
                      isToday(d) ? 'bg-primary/[0.03]' : isWeekend(d) ? 'bg-muted/10' : '',
                    )}
                    style={{ left: i * DAY_WIDTH, width: DAY_WIDTH }}
                  />
                )
              })}
              <TaskBar task={task} />
            </div>
          ))
        )}
        {/* Empty bottom row */}
        <div
          className="relative border-b border-border/20"
          style={{ height: ROW_HEIGHT }}
          onContextMenu={handleContextMenu}
        />
      </div>
    )

    const TaskListPanel = () => (
      <div
        ref={leftPanelRef}
        className="w-[200px] shrink-0 border-r border-border overflow-y-auto bg-card"
        onScroll={handleLeftScroll}
      >
        <div className="sticky top-0 z-10 bg-card border-b border-border px-3 flex items-center" style={{ height: 34 }}>
          <span className="text-[11px] font-semibold text-muted-foreground">任务名称</span>
          <span className="ml-auto text-[10px] text-muted-foreground/50">{tasks.length}</span>
        </div>
        {sortedTasks.length === 0 ? (
          <div className="px-3 flex items-center text-[11px] text-muted-foreground/40" style={{ height: ROW_HEIGHT }}>
            暂无任务
          </div>
        ) : (
          sortedTasks.map(task => (
            <div key={task.id} className="flex items-center gap-2 px-3 border-b border-border/20" style={{ height: ROW_HEIGHT }}>
              <div className={cn('w-2 h-2 rounded-full shrink-0', task.color)} />
              <span className={cn('text-[12px] truncate flex-1', task.status === 'completed' ? 'line-through text-muted-foreground' : 'text-foreground')}>
                {task.name}
              </span>
              <Badge variant={STATUS_VARIANTS[task.status]} className="text-[9px] px-1 py-0 h-4 shrink-0 leading-none">
                {STATUS_LABELS[task.status]}
              </Badge>
            </div>
          ))
        )}
      </div>
    )

    const ContextMenuPopup = () => (
      <div
        ref={contextMenuRef}
        className="fixed z-[100] min-w-[160px] rounded-lg border border-border bg-popover shadow-xl py-1"
        style={{ left: contextMenu!.x, top: contextMenu!.y }}
      >
        <div className="px-2 py-1 text-[10px] text-muted-foreground border-b border-border/50 mb-1">
          {contextMenu!.date}
        </div>
        <button
          className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-foreground hover:bg-accent transition-colors text-left"
          onClick={() => {
            const d = contextMenu!.date
            setContextMenu(null)
            setDialog({ mode: 'create', defaultStartDate: d })
          }}
        >
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
        setErrors(e)
        return Object.keys(e).length === 0
      }

      const submit = () => {
        if (!validate()) return
        handleSave({ name: name.trim(), description: desc.trim(), startDate, ddl, status }, edit?.id)
      }

      return (
        <div
          data-backdrop="true"
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center"
          onClick={(e) => { if ((e.target as HTMLElement).dataset.backdrop === 'true') setDialog(null) }}
          onKeyDown={(e) => { if (e.key === 'Escape') setDialog(null) }}
        >
          <div className="bg-card rounded-xl border border-border shadow-xl w-[420px] max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-5 py-3 border-b border-border">
              <h3 className="text-sm font-semibold">{dialog.mode === 'create' ? '新增工作' : '编辑工作'}</h3>
              <button className="h-6 w-6 rounded hover:bg-accent flex items-center justify-center" onClick={() => setDialog(null)}>
                <X className="h-4 w-4 text-muted-foreground" />
              </button>
            </div>
            <div className="px-5 py-4 space-y-4">
              <div className="space-y-1.5">
                <Label>任务名称</Label>
                <Input placeholder="输入任务名称" value={name}
                  onChange={(e: any) => { setName(e.target.value); setErrors(prev => ({ ...prev, name: '' })) }}
                  className={cn('h-9 text-sm', errors.name && 'border-destructive')} autoFocus
                  onKeyDown={(e: any) => { if (e.key === 'Enter') submit() }} />
                {errors.name && <p className="text-[11px] text-destructive">{errors.name}</p>}
              </div>
              <div className="space-y-1.5">
                <Label>描述</Label>
                <textarea placeholder="输入任务描述（可选）" value={desc} onChange={(e: any) => setDesc(e.target.value)} rows={2}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring resize-none" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>开始日期</Label>
                  <input type="date" value={startDate} onChange={(e: any) => setStartDate(e.target.value)}
                    className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-ring" />
                </div>
                <div className="space-y-1.5">
                  <Label>截止日期</Label>
                  <input type="date" value={ddl}
                    onChange={(e: any) => { setDdl(e.target.value); setErrors(prev => ({ ...prev, ddl: '' })) }}
                    className={cn('w-full h-9 rounded-md border bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-ring', errors.ddl ? 'border-destructive' : 'border-input')} />
                  {errors.ddl && <p className="text-[11px] text-destructive">{errors.ddl}</p>}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>状态</Label>
                <div className="flex gap-1.5">
                  {(['pending', 'in-progress', 'completed'] as Task['status'][]).map(s => (
                    <button key={s}
                      className={cn('flex-1 h-8 rounded-md text-[12px] font-medium border transition-colors',
                        status === s ? 'bg-primary text-primary-foreground border-primary' : 'bg-background text-muted-foreground border-input hover:bg-accent')}
                      onClick={() => setStatus(s)}>{STATUS_LABELS[s]}</button>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border bg-muted/30 rounded-b-xl">
              <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setDialog(null)} disabled={saving}>取消</Button>
              <Button size="sm" className="h-8 text-xs" onClick={submit} disabled={saving}>
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

      return (
        <div
          ref={tooltipRef}
          className="fixed z-[100] w-[280px] rounded-lg border border-border bg-popover shadow-xl p-4 space-y-3"
          style={{ left: tooltip.x, top: tooltip.y }}
          onMouseEnter={cancelHideTooltip}
          onMouseLeave={() => setTooltip(null)}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <div className={cn('w-3 h-3 rounded-full shrink-0', task.color)} />
              <h4 className="text-[13px] font-semibold truncate">{task.name}</h4>
            </div>
            <button className="h-5 w-5 rounded hover:bg-accent flex items-center justify-center shrink-0 ml-2" onClick={() => setTooltip(null)}>
              <X className="h-3 w-3 text-muted-foreground" />
            </button>
          </div>
          {task.description && <p className="text-[11px] text-muted-foreground leading-relaxed">{task.description}</p>}
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-[11px]">
              <Calendar className="h-3 w-3 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground">开始：</span><span className="text-foreground">{task.startDate}</span>
            </div>
            <div className="flex items-center gap-2 text-[11px]">
              <Flag className="h-3 w-3 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground">截止：</span>
              <span className={cn(overdue && 'text-destructive font-medium')}>{task.ddl}{overdue && ' (已逾期)'}</span>
            </div>
            <Badge variant={STATUS_VARIANTS[task.status]} className="text-[9px] px-1 py-0 h-4">{STATUS_LABELS[task.status]}</Badge>
          </div>
          <div className="flex gap-2 pt-1">
            <Button variant="outline" size="sm" className="h-7 text-[11px] flex-1" onClick={() => { setTooltip(null); setDialog({ mode: 'edit', task }) }}>
              <Pencil className="h-3 w-3 mr-1" />编辑
            </Button>
            <Button variant="destructive" size="sm" className="h-7 text-[11px] flex-1" onClick={() => handleDelete(task.id)}>
              <Trash2 className="h-3 w-3 mr-1" />删除
            </Button>
          </div>
        </div>
      )
    }

    const TitleBar = () => (
      <div className="flex items-center gap-3 px-4 py-1.5 border-b border-border bg-card shrink-0" style={{ height: titleBarHeight }}>
        <BarChart3 className="h-4 w-4 text-muted-foreground shrink-0" />
        <h1 className="text-sm font-semibold">甘特图</h1>
        <span className="text-[10px] text-muted-foreground">· {tasks.length} 任务</span>
        <div className="flex-1" />
        <div className="flex items-center gap-0.5">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={zoomIn}><ZoomIn className="h-3.5 w-3.5" /></Button>
          <span className="text-[10px] text-muted-foreground w-7 text-center">{daysToShow}天</span>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={zoomOut}><ZoomOut className="h-3.5 w-3.5" /></Button>
        </div>
        <div className="flex items-center gap-0.5">
          <Button variant="outline" size="sm" className="h-7 text-[11px] px-2" onClick={panLeft}><ChevronLeft className="h-3.5 w-3.5" /></Button>
          <Button variant="outline" size="sm" className="h-7 text-[11px] px-2" onClick={goToday}>今天</Button>
          <Button variant="outline" size="sm" className="h-7 text-[11px] px-2" onClick={panRight}><ChevronRight className="h-3.5 w-3.5" /></Button>
        </div>
        <Button size="sm" className="h-7 text-[11px] px-3" onClick={() => setDialog({ mode: 'create', defaultStartDate: formatDate(new Date()) })}>
          <Plus className="h-3.5 w-3.5 mr-1" />新增工作
        </Button>
      </div>
    )

    // =====================================================================
    // Main
    // =====================================================================

    return (
      <div className="h-full flex flex-col bg-background select-none">
        <TitleBar />
        <div className="flex flex-1 overflow-hidden">
          <TaskListPanel />
          <div ref={scrollRef} className="flex-1 overflow-auto" onScroll={handleMainScroll}>
            <div style={{ minWidth: totalDays * DAY_WIDTH }}>
              <TimelineHeader />
              <TimelineBody />
            </div>
          </div>
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
      description:
        '查询甘特图任务列表。可按日期范围、状态筛选。不传参数时返回全部。' +
        '返回 id、名称、日期、状态等摘要。需要查看某个任务描述时用 gantt_get。',
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
          q = args.id.length === 8 ? q.ilike('id', args.id + '%') : q.eq('id', args.id)
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
