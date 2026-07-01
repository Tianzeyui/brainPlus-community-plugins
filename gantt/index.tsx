/**
 * 甘特图插件 — 工作排程与时间线可视化
 *
 * 能力：右键新增工作、可视化甘特图条形图、悬停详情/编辑/删除
 * 数据存储：Supabase（gantt_tasks 表）
 */
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { BarChart3, Plus, ChevronLeft, ChevronRight, X, Pencil, Trash2, Calendar, Flag, ZoomIn, ZoomOut, GripHorizontal, Loader2, AlertTriangle } from 'lucide-react'
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
  startDate: string   // YYYY-MM-DD
  ddl: string         // YYYY-MM-DD
  color: string       // Tailwind bg class
  status: 'pending' | 'in-progress' | 'completed'
  createdAt: string
}

/** Supabase row — snake_case columns */
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
  updated_at: string
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

const DAY_WIDTH = 64
const ROW_HEIGHT = 44
const MIN_BAR_WIDTH = 6
const TOOLTIP_DELAY = 300
const TABLE_NAME = 'gantt_tasks'

const COLORS = [
  'bg-chart-1',
  'bg-chart-2',
  'bg-chart-3',
  'bg-chart-4',
  'bg-chart-5',
  'bg-blue-500',
  'bg-green-500',
  'bg-purple-500',
  'bg-orange-500',
  'bg-pink-500',
]

const STATUS_LABELS: Record<Task['status'], string> = {
  'pending': '待开始',
  'in-progress': '进行中',
  'completed': '已完成',
}

const STATUS_VARIANTS: Record<Task['status'], 'secondary' | 'default' | 'outline'> = {
  'pending': 'secondary',
  'in-progress': 'default',
  'completed': 'outline',
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
  return new Date(s + 'T00:00:00')
}

function diffDays(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / 86400000)
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
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

/** Map Supabase snake_case row → camelCase Task */
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

  /** Get Supabase client or throw */
  function getClient() {
    const client = supabase.getClient()
    if (!client) throw new Error('Supabase 未配置')
    return client
  }

  // =========================================================================
  // GanttPage — 主页面组件
  // =========================================================================

  const GanttPage = () => {
    // ---- State ----
    const [tasks, setTasks] = useState<Task[]>([])
    const [loaded, setLoaded] = useState(false)
    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState('')
    const [saving, setSaving] = useState(false)
    const [supabaseOk, setSupabaseOk] = useState(true)
    const [timelineStart, setTimelineStart] = useState<Date>(() => getMonday(new Date()))
    const [daysToShow, setDaysToShow] = useState(21)
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
    const [tooltip, setTooltip] = useState<TooltipState | null>(null)
    const [dialog, setDialog] = useState<DialogState | null>(null)

    const leftPanelRef = useRef<HTMLDivElement>(null)
    const rightPanelRef = useRef<HTMLDivElement>(null)
    const syncScrollRef = useRef(false)
    const tooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const contextMenuRef = useRef<HTMLDivElement>(null)
    const tooltipRef = useRef<HTMLDivElement>(null)

    // ---- Derived values ----
    const timelineEnd = useMemo(() => {
      const end = new Date(timelineStart)
      end.setDate(end.getDate() + daysToShow - 1)
      return end
    }, [timelineStart, daysToShow])

    const sortedTasks = useMemo(() =>
      [...tasks].sort((a, b) => {
        if (a.startDate !== b.startDate) return a.startDate < b.startDate ? -1 : 1
        return a.createdAt < b.createdAt ? -1 : 1
      }),
    [tasks])

    const fullRange = useMemo(() => {
      if (tasks.length === 0) return { start: timelineStart, end: timelineEnd }
      let min = parseDate(tasks[0].startDate)
      let max = parseDate(tasks[0].ddl)
      tasks.forEach(t => {
        const s = parseDate(t.startDate)
        const d = parseDate(t.ddl)
        if (s < min) min = s
        if (d > max) max = d
      })
      min.setDate(min.getDate() - 2)
      max.setDate(max.getDate() + 2)
      return { start: min, end: max }
    }, [tasks, timelineStart, timelineEnd])

    const totalDays = useMemo(() => diffDays(fullRange.end, fullRange.start) + 1, [fullRange])

    // ---- Load tasks from Supabase ----
    const loadTasks = useCallback(async () => {
      setLoading(true)
      setLoadError('')
      try {
        const sb = getClient()
        const { data, error } = await sb
          .from(TABLE_NAME)
          .select('*')
          .order('start_date', { ascending: true })

        if (error) throw error
        const rows = (data || []) as TaskRow[]
        const parsed = rows.map(rowToTask)
        setTasks(parsed)

        // Expand timeline to cover earliest task
        if (parsed.length > 0) {
          let min = parseDate(parsed[0].startDate)
          parsed.forEach(t => {
            const s = parseDate(t.startDate)
            if (s < min) min = s
          })
          min.setDate(min.getDate() - 2)
          setTimelineStart(getMonday(min))
        }
      } catch (e: any) {
        if (e.message === 'Supabase 未配置') {
          setSupabaseOk(false)
          setLoadError('请先在设置中配置 Supabase 连接')
        } else {
          setLoadError(e.message || '加载任务失败')
        }
        ui.toast('加载任务失败: ' + (e.message || 'unknown'), 'error')
      } finally {
        setLoading(false)
        setLoaded(true)
      }
    }, [ui])

    // Fetch on mount
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

    // ---- Scroll sync ----
    const handleLeftScroll = useCallback(() => {
      if (syncScrollRef.current) return
      syncScrollRef.current = true
      if (leftPanelRef.current && rightPanelRef.current) {
        rightPanelRef.current.scrollTop = leftPanelRef.current.scrollTop
      }
      requestAnimationFrame(() => { syncScrollRef.current = false })
    }, [])

    const handleRightScroll = useCallback(() => {
      if (syncScrollRef.current) return
      syncScrollRef.current = true
      if (leftPanelRef.current && rightPanelRef.current) {
        leftPanelRef.current.scrollTop = rightPanelRef.current.scrollTop
      }
      requestAnimationFrame(() => { syncScrollRef.current = false })
    }, [])

    // ---- Context menu dismiss ----
    useEffect(() => {
      if (!contextMenu) return
      const dismiss = () => setContextMenu(null)
      const handleClick = (e: MouseEvent) => {
        if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
          dismiss()
        }
      }
      const handleKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') dismiss()
      }
      document.addEventListener('mousedown', handleClick)
      document.addEventListener('keydown', handleKey)
      window.addEventListener('scroll', dismiss, true)
      return () => {
        document.removeEventListener('mousedown', handleClick)
        document.removeEventListener('keydown', handleKey)
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

    // ---- Right-click handler ----
    const handleTimelineContextMenu = useCallback((e: React.MouseEvent) => {
      e.preventDefault()
      const container = rightPanelRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      const scrollLeft = container.scrollLeft
      const clickX = e.clientX - rect.left + scrollLeft
      const dayIndex = Math.floor(clickX / DAY_WIDTH)
      const clickedDate = new Date(fullRange.start)
      clickedDate.setDate(clickedDate.getDate() + dayIndex)
      let mx = e.clientX
      let my = e.clientY
      if (mx + 170 > window.innerWidth) mx = window.innerWidth - 175
      if (my + 50 > window.innerHeight) my = window.innerHeight - 55
      setContextMenu({ x: mx, y: my, date: formatDate(clickedDate) })
    }, [fullRange.start])

    // ---- Task CRUD (Supabase) ----
    const handleSaveTask = useCallback(async (
      taskData: Omit<Task, 'id' | 'createdAt' | 'color'>,
      editId?: string,
    ) => {
      setSaving(true)
      try {
        const sb = getClient()

        if (editId) {
          // Update
          const { error } = await sb
            .from(TABLE_NAME)
            .update({
              name: taskData.name,
              description: taskData.description,
              start_date: taskData.startDate,
              ddl: taskData.ddl,
              status: taskData.status,
            })
            .eq('id', editId)

          if (error) throw error
          setTasks(prev => prev.map(t =>
            t.id === editId ? { ...t, ...taskData } : t
          ))
          ui.toast('任务已更新', 'success')
        } else {
          // Insert — pick least-used color
          const colorCounts = new Map<string, number>()
          COLORS.forEach(c => colorCounts.set(c, 0))
          tasks.forEach(t => colorCounts.set(t.color, (colorCounts.get(t.color) || 0) + 1))
          let bestColor = COLORS[0]
          let bestCount = Infinity
          colorCounts.forEach((cnt, col) => {
            if (cnt < bestCount) { bestCount = cnt; bestColor = col }
          })

          const { data, error } = await sb
            .from(TABLE_NAME)
            .insert({
              name: taskData.name,
              description: taskData.description,
              start_date: taskData.startDate,
              ddl: taskData.ddl,
              color: bestColor,
              status: taskData.status,
            })
            .select()
            .single()

          if (error) throw error
          const newTask = rowToTask(data as TaskRow)
          setTasks(prev => [...prev, newTask])
          ui.toast('任务已创建', 'success')
        }
        setDialog(null)
      } catch (e: any) {
        ui.toast('保存失败: ' + (e.message || 'unknown'), 'error')
      } finally {
        setSaving(false)
      }
    }, [tasks, ui])

    const handleDeleteTask = useCallback(async (taskId: string) => {
      const result = await confirm({
        title: '删除任务',
        message: '确定要删除这个任务吗？此操作不可撤销。',
        actions: [
          { key: 'ok', label: '确认删除', variant: 'destructive' },
          { key: 'cancel', label: '取消' },
        ],
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

    // ---- Bar hover handlers ----
    const handleBarMouseEnter = useCallback((task: Task, e: React.MouseEvent) => {
      if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current)
      tooltipTimerRef.current = setTimeout(() => {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
        let tx = rect.left + rect.width / 2 - 140
        let ty = rect.top - 210
        if (ty < 8) ty = rect.bottom + 8
        if (tx < 8) tx = 8
        if (tx + 280 > window.innerWidth) tx = window.innerWidth - 288
        if (ty + 200 > window.innerHeight) ty = window.innerHeight - 208
        setTooltip({ task, x: tx, y: ty })
      }, TOOLTIP_DELAY)
    }, [])

    const handleBarMouseLeave = useCallback(() => {
      if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current)
      tooltipTimerRef.current = setTimeout(() => setTooltip(null), 150)
    }, [])

    const handleTooltipEnter = useCallback(() => {
      if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current)
    }, [])

    const handleTooltipLeave = useCallback(() => {
      setTooltip(null)
    }, [])

    // ---- Navigation ----
    const goToday = useCallback(() => {
      setTimelineStart(getMonday(new Date()))
      if (rightPanelRef.current) {
        const todayIdx = diffDays(new Date(), fullRange.start)
        if (todayIdx >= 0) {
          rightPanelRef.current.scrollLeft = todayIdx * DAY_WIDTH - 100
        }
      }
    }, [fullRange.start])

    const panLeft = useCallback(() => {
      const newStart = new Date(timelineStart)
      newStart.setDate(newStart.getDate() - 7)
      setTimelineStart(newStart)
    }, [timelineStart])

    const panRight = useCallback(() => {
      const newStart = new Date(timelineStart)
      newStart.setDate(newStart.getDate() + 7)
      setTimelineStart(newStart)
    }, [timelineStart])

    const zoomIn = useCallback(() => setDaysToShow(d => clamp(d - 7, 7, 42)), [])
    const zoomOut = useCallback(() => setDaysToShow(d => clamp(d + 7, 7, 42)), [])

    // ---- Scroll today into view on mount ----
    useEffect(() => {
      if (loaded && rightPanelRef.current) {
        const todayIdx = diffDays(new Date(), fullRange.start)
        if (todayIdx >= 0) {
          rightPanelRef.current.scrollLeft = Math.max(0, todayIdx * DAY_WIDTH - 120)
        }
      }
    }, [loaded]) // eslint-disable-line react-hooks/exhaustive-deps

    // ---- Loading state ----
    if (loading) {
      return (
        <div className="h-full flex items-center justify-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          <span className="text-sm text-muted-foreground">加载任务数据…</span>
        </div>
      )
    }

    // ---- Supabase not configured ----
    if (!supabaseOk) {
      return (
        <div className="h-full flex flex-col items-center justify-center gap-3 p-8">
          <AlertTriangle className="h-8 w-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">{loadError}</p>
          <p className="text-[11px] text-muted-foreground/50 max-w-xs text-center">
            甘特图插件需要 Supabase 来存储任务数据。请在 Stardust 设置 → 能力中配置 Supabase 连接。
          </p>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs mt-2"
            onClick={() => loadTasks()}
          >
            重试
          </Button>
        </div>
      )
    }

    // ---- Load error (other than not configured) ----
    if (loadError && !loading && supabaseOk) {
      return (
        <div className="h-full flex flex-col items-center justify-center gap-3 p-8">
          <AlertTriangle className="h-8 w-8 text-destructive/40" />
          <p className="text-sm text-destructive">{loadError}</p>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs mt-2"
            onClick={() => loadTasks()}
          >
            重试
          </Button>
        </div>
      )
    }

    // =====================================================================
    // Sub-components
    // =====================================================================

    // ---- TimelineHeader ----
    const TimelineHeader = () => (
      <div className="sticky top-0 z-10 bg-card flex border-b border-border" style={{ minWidth: totalDays * DAY_WIDTH }}>
        {Array.from({ length: totalDays }, (_, i) => {
          const d = new Date(fullRange.start)
          d.setDate(d.getDate() + i)
          const today = isToday(d)
          const weekend = isWeekend(d)
          const monday = isMonday(d)
          return (
            <div
              key={i}
              className={cn(
                'flex flex-col items-center justify-center border-r py-1.5 shrink-0',
                monday ? 'border-r-2 border-r-border' : 'border-r border-r-border/30',
                today ? 'bg-primary/10' : weekend ? 'bg-muted/20' : '',
              )}
              style={{ width: DAY_WIDTH }}
            >
              <span className={cn(
                'text-[11px] font-medium leading-tight',
                today ? 'text-primary' : weekend ? 'text-muted-foreground' : 'text-foreground',
              )}>
                {d.getMonth() + 1}/{d.getDate()}
              </span>
              <span className={cn(
                'text-[10px] leading-tight',
                today ? 'text-primary/70' : 'text-muted-foreground/70',
              )}>
                {WEEKDAY_LABELS[d.getDay()]}
              </span>
            </div>
          )
        })}
      </div>
    )

    // ---- TaskBar ----
    const TaskBar = ({ task }: { task: Task }) => {
      const start = parseDate(task.startDate)
      const end = parseDate(task.ddl)
      const baseStart = fullRange.start

      const left = diffDays(start, baseStart) * DAY_WIDTH
      const width = Math.max((diffDays(end, start) + 1) * DAY_WIDTH, MIN_BAR_WIDTH)
      const overdue = parseDate(task.ddl) < new Date() && task.status !== 'completed'

      return (
        <div
          className={cn(
            'absolute rounded-md flex items-center px-2 gap-1.5 cursor-pointer transition-shadow hover:shadow-md group',
            task.color,
            task.status === 'completed' ? 'opacity-50' : '',
            overdue ? 'ring-2 ring-destructive ring-offset-2 ring-offset-background' : '',
          )}
          style={{ left, top: 6, width, height: ROW_HEIGHT - 12, minWidth: MIN_BAR_WIDTH }}
          onMouseEnter={(e) => handleBarMouseEnter(task, e)}
          onMouseLeave={handleBarMouseLeave}
        >
          {width > 50 ? (
            <>
              <GripHorizontal className="h-3 w-3 shrink-0 text-white/70 opacity-0 group-hover:opacity-100 transition-opacity" />
              <span className={cn(
                'text-[11px] font-medium text-white truncate',
                task.status === 'completed' ? 'line-through opacity-70' : '',
              )}>
                {task.name}
              </span>
            </>
          ) : null}
        </div>
      )
    }

    // ---- TimelineBody ----
    const TimelineBody = () => (
      <div
        className="relative"
        style={{ minWidth: totalDays * DAY_WIDTH }}
        onContextMenu={handleTimelineContextMenu}
      >
        {sortedTasks.length === 0 ? (
          <div
            className="flex items-center justify-center text-xs text-muted-foreground/50 select-none"
            style={{ height: ROW_HEIGHT }}
            onContextMenu={handleTimelineContextMenu}
          >
            右键此处新增工作
          </div>
        ) : (
          sortedTasks.map(task => (
            <div
              key={task.id}
              className="relative border-b border-border/30"
              style={{ height: ROW_HEIGHT }}
              onContextMenu={handleTimelineContextMenu}
            >
              {Array.from({ length: totalDays }, (_, i) => {
                const d = new Date(fullRange.start)
                d.setDate(d.getDate() + i)
                const monday = isMonday(d)
                return (
                  <div
                    key={i}
                    className={cn(
                      'absolute top-0 bottom-0',
                      monday ? 'border-r-2 border-r-border/20' : 'border-r border-r-border/10',
                      isToday(d) ? 'bg-primary/5' : isWeekend(d) ? 'bg-muted/10' : '',
                    )}
                    style={{ left: i * DAY_WIDTH, width: DAY_WIDTH }}
                  />
                )
              })}
              <TaskBar task={task} />
            </div>
          ))
        )}
        {/* Empty row for adding tasks at the end */}
        <div
          className="relative border-b border-border/30"
          style={{ height: ROW_HEIGHT }}
          onContextMenu={handleTimelineContextMenu}
        >
          {Array.from({ length: totalDays }, (_, i) => {
            const d = new Date(fullRange.start)
            d.setDate(d.getDate() + i)
            return (
              <div
                key={i}
                className={cn(
                  'absolute top-0 bottom-0',
                  isMonday(d) ? 'border-r-2 border-r-border/20' : 'border-r border-r-border/10',
                  isToday(d) ? 'bg-primary/5' : isWeekend(d) ? 'bg-muted/10' : '',
                )}
                style={{ left: i * DAY_WIDTH, width: DAY_WIDTH }}
              />
            )
          })}
        </div>
      </div>
    )

    // ---- TaskListPanel ----
    const TaskListPanel = () => (
      <div
        ref={leftPanelRef}
        className="w-[200px] shrink-0 border-r border-border overflow-y-auto bg-card"
        onScroll={handleLeftScroll}
        style={{ maxHeight: 'calc(100vh - 48px)' }}
      >
        <div className="sticky top-0 z-10 bg-card border-b border-border px-3 flex items-center" style={{ height: 36 }}>
          <span className="text-[11px] font-semibold text-muted-foreground">任务名称</span>
        </div>
        {sortedTasks.length === 0 ? (
          <div className="px-3 flex items-center text-[11px] text-muted-foreground/50" style={{ height: ROW_HEIGHT }}>
            暂无任务
          </div>
        ) : (
          sortedTasks.map(task => (
            <div
              key={task.id}
              className="flex items-center gap-2 px-3 border-b border-border/30"
              style={{ height: ROW_HEIGHT }}
            >
              <div className={cn('w-2.5 h-2.5 rounded-full shrink-0', task.color)} />
              <span className={cn(
                'text-[12px] truncate flex-1',
                task.status === 'completed' ? 'line-through text-muted-foreground' : 'text-foreground',
              )}>
                {task.name}
              </span>
              <Badge variant={STATUS_VARIANTS[task.status]} className="text-[10px] px-1 py-0 h-4 shrink-0">
                {STATUS_LABELS[task.status]}
              </Badge>
            </div>
          ))
        )}
      </div>
    )

    // ---- ContextMenu ----
    const ContextMenuPopup = () => {
      return (
        <div
          ref={contextMenuRef}
          className="fixed z-50 min-w-[160px] rounded-lg border border-border bg-popover shadow-xl py-1 animate-in fade-in zoom-in-95"
          style={{ left: contextMenu!.x, top: contextMenu!.y }}
        >
          <div className="px-2 py-1 text-[10px] text-muted-foreground border-b border-border/50 mb-1">
            {contextMenu!.date}
          </div>
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-foreground hover:bg-accent transition-colors text-left"
            onClick={() => {
              setContextMenu(null)
              setDialog({ mode: 'create', defaultStartDate: contextMenu!.date })
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            新增工作
          </button>
        </div>
      )
    }

    // ---- TaskFormDialog ----
    const TaskFormDialog = ({ dialog }: { dialog: DialogState }) => {
      const editTask = dialog.mode === 'edit' ? dialog.task : null
      const [name, setName] = useState(editTask?.name || '')
      const [description, setDescription] = useState(editTask?.description || '')
      const [startDate, setStartDate] = useState(
        editTask?.startDate || dialog.defaultStartDate || formatDate(new Date())
      )
      const [ddl, setDdl] = useState(
        editTask?.ddl || (() => {
          const d = new Date()
          d.setDate(d.getDate() + 7)
          return formatDate(d)
        })()
      )
      const [status, setStatus] = useState<Task['status']>(editTask?.status || 'pending')
      const [errors, setErrors] = useState<Record<string, string>>({})

      const validate = (): boolean => {
        const errs: Record<string, string> = {}
        if (!name.trim()) errs.name = '请输入任务名称'
        if (parseDate(ddl) < parseDate(startDate)) errs.ddl = '截止日期不能早于开始日期'
        setErrors(errs)
        return Object.keys(errs).length === 0
      }

      const handleSubmit = () => {
        if (!validate()) return
        handleSaveTask({ name: name.trim(), description, startDate, ddl, status }, editTask?.id)
      }

      const handleBackdropClick = (e: React.MouseEvent) => {
        if ((e.target as HTMLElement).dataset.backdrop === 'true') {
          setDialog(null)
        }
      }

      const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') setDialog(null)
      }

      return (
        <div
          data-backdrop="true"
          className="fixed inset-0 z-40 bg-black/50 flex items-center justify-center"
          onClick={handleBackdropClick}
          onKeyDown={handleKeyDown}
        >
          <div className="bg-card rounded-xl border border-border shadow-xl w-[420px] max-h-[90vh] overflow-y-auto animate-in zoom-in-95 fade-in">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <h3 className="text-sm font-semibold text-foreground">
                {dialog.mode === 'create' ? '新增工作' : '编辑工作'}
              </h3>
              <button
                className="h-6 w-6 rounded-md hover:bg-accent flex items-center justify-center transition-colors"
                onClick={() => setDialog(null)}
              >
                <X className="h-4 w-4 text-muted-foreground" />
              </button>
            </div>

            {/* Body */}
            <div className="px-5 py-4 space-y-4">
              <div className="space-y-1.5">
                <Label>任务名称</Label>
                <Input
                  placeholder="输入任务名称"
                  value={name}
                  onChange={(e: any) => { setName(e.target.value); setErrors(e => ({ ...e, name: '' })) }}
                  className={cn('h-9 text-sm', errors.name && 'border-destructive focus:ring-destructive')}
                  autoFocus
                  onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 'Enter') handleSubmit() }}
                />
                {errors.name && <p className="text-[11px] text-destructive">{errors.name}</p>}
              </div>

              <div className="space-y-1.5">
                <Label>描述</Label>
                <textarea
                  placeholder="输入任务描述（可选）"
                  value={description}
                  onChange={(e: any) => setDescription(e.target.value)}
                  rows={3}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 outline-none focus:ring-1 focus:ring-ring resize-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>开始日期</Label>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e: any) => setStartDate(e.target.value)}
                    className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>截止日期</Label>
                  <input
                    type="date"
                    value={ddl}
                    onChange={(e: any) => { setDdl(e.target.value); setErrors(e => ({ ...e, ddl: '' })) }}
                    className={cn(
                      'w-full h-9 rounded-md border bg-background px-3 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring',
                      errors.ddl ? 'border-destructive focus:ring-destructive' : 'border-input',
                    )}
                  />
                  {errors.ddl && <p className="text-[11px] text-destructive">{errors.ddl}</p>}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>状态</Label>
                <div className="flex gap-1.5">
                  {(['pending', 'in-progress', 'completed'] as Task['status'][]).map(s => (
                    <button
                      key={s}
                      className={cn(
                        'flex-1 h-8 rounded-md text-[12px] font-medium transition-colors border',
                        status === s
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-background text-muted-foreground border-input hover:bg-accent',
                      )}
                      onClick={() => setStatus(s)}
                    >
                      {STATUS_LABELS[s]}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border bg-muted/30 rounded-b-xl">
              <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setDialog(null)} disabled={saving}>
                取消
              </Button>
              <Button size="sm" className="h-8 text-xs" onClick={handleSubmit} disabled={saving}>
                {saving ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                {saving ? '保存中…' : dialog.mode === 'create' ? '创建' : '保存'}
              </Button>
            </div>
          </div>
        </div>
      )
    }

    // ---- TaskTooltip ----
    const TaskTooltipPopup = ({ tooltip }: { tooltip: TooltipState }) => {
      const { task } = tooltip

      return (
        <div
          ref={tooltipRef}
          className="fixed z-50 w-[280px] rounded-lg border border-border bg-card shadow-xl p-4 space-y-3 animate-in fade-in zoom-in-95"
          style={{ left: tooltip.x, top: tooltip.y }}
          onMouseEnter={handleTooltipEnter}
          onMouseLeave={handleTooltipLeave}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className={cn('w-3 h-3 rounded-full', task.color)} />
              <h4 className="text-[13px] font-semibold text-foreground truncate max-w-[180px]">{task.name}</h4>
            </div>
            <button
              className="h-5 w-5 rounded hover:bg-accent flex items-center justify-center transition-colors"
              onClick={() => setTooltip(null)}
            >
              <X className="h-3 w-3 text-muted-foreground" />
            </button>
          </div>

          {task.description && (
            <p className="text-[11px] text-muted-foreground leading-relaxed">{task.description}</p>
          )}

          <div className="space-y-1">
            <div className="flex items-center gap-2 text-[11px]">
              <Calendar className="h-3 w-3 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground">开始：</span>
              <span className="text-foreground">{task.startDate}</span>
            </div>
            <div className="flex items-center gap-2 text-[11px]">
              <Flag className="h-3 w-3 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground">截止：</span>
              <span className={cn(
                'text-foreground',
                parseDate(task.ddl) < new Date() && task.status !== 'completed' ? 'text-destructive font-medium' : '',
              )}>
                {task.ddl}
                {parseDate(task.ddl) < new Date() && task.status !== 'completed' ? ' (已逾期)' : ''}
              </span>
            </div>
            <div className="flex items-center gap-2 text-[11px]">
              <Badge variant={STATUS_VARIANTS[task.status]} className="text-[10px] px-1 py-0 h-4">
                {STATUS_LABELS[task.status]}
              </Badge>
            </div>
          </div>

          <div className="flex gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[11px] flex-1"
              onClick={() => {
                setTooltip(null)
                setDialog({ mode: 'edit', task })
              }}
            >
              <Pencil className="h-3 w-3 mr-1" />编辑
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="h-7 text-[11px] flex-1"
              onClick={() => handleDeleteTask(task.id)}
            >
              <Trash2 className="h-3 w-3 mr-1" />删除
            </Button>
          </div>
        </div>
      )
    }

    // ---- TitleBar ----
    const TitleBar = () => (
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border bg-card shrink-0">
        <BarChart3 className="h-4 w-4 text-muted-foreground shrink-0" />
        <h1 className="text-sm font-semibold text-foreground">甘特图</h1>
        <span className="text-[10px] text-muted-foreground">· {tasks.length} 个任务</span>
        {!supabaseOk && (
          <Badge variant="destructive" className="text-[10px] px-1 py-0 h-4">未连接</Badge>
        )}

        <div className="flex-1" />

        {/* Zoom */}
        <div className="flex items-center gap-0.5">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={zoomIn} title="放大">
            <ZoomIn className="h-3.5 w-3.5" />
          </Button>
          <span className="text-[10px] text-muted-foreground w-8 text-center">{daysToShow}天</span>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={zoomOut} title="缩小">
            <ZoomOut className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Pan */}
        <div className="flex items-center gap-0.5">
          <Button variant="outline" size="sm" className="h-7 text-[11px] px-2" onClick={panLeft}>
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <Button variant="outline" size="sm" className="h-7 text-[11px] px-2" onClick={goToday}>
            今天
          </Button>
          <Button variant="outline" size="sm" className="h-7 text-[11px] px-2" onClick={panRight}>
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Add */}
        <Button
          size="sm"
          className="h-7 text-[11px] px-3"
          onClick={() => setDialog({ mode: 'create', defaultStartDate: formatDate(new Date()) })}
        >
          <Plus className="h-3.5 w-3.5 mr-1" />新增工作
        </Button>
      </div>
    )

    // =====================================================================
    // Main Render
    // =====================================================================

    return (
      <div className="h-full flex flex-col bg-background select-none">
        <TitleBar />

        {/* Main content */}
        <div className="flex flex-1 overflow-hidden">
          <div className="shrink-0" style={{ width: 200 }}>
            <TaskListPanel />
          </div>

          <div
            ref={rightPanelRef}
            className="flex-1 overflow-auto"
            onScroll={handleRightScroll}
          >
            <TimelineHeader />
            <TimelineBody />
          </div>
        </div>

        {/* Overlays */}
        {contextMenu && <ContextMenuPopup />}
        {dialog && <TaskFormDialog dialog={dialog} />}
        {tooltip && <TaskTooltipPopup tooltip={tooltip} />}
      </div>
    )
  }

  // =========================================================================
  // Register plugin
  // =========================================================================

  ctx.registerNav({ id: 'gantt', label: '甘特图', icon: 'BarChart3', order: 80 })
  ctx.registerRoute('gantt', () => Promise.resolve({ default: GanttPage }))
}
