-- ============================================
-- Stardust 甘特图插件 - 数据库初始化脚本
-- 在 Supabase SQL Editor 中执行此脚本
-- ============================================

-- 1. 创建甘特图任务表
CREATE TABLE IF NOT EXISTS public.gantt_tasks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  start_date  DATE NOT NULL,
  ddl         DATE NOT NULL,
  color       TEXT NOT NULL DEFAULT 'bg-chart-1',
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in-progress', 'completed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ddl_not_before_start CHECK (ddl >= start_date)
);

-- 2. 创建索引
CREATE INDEX IF NOT EXISTS idx_gantt_tasks_user_id    ON public.gantt_tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_gantt_tasks_start_date ON public.gantt_tasks(start_date);
CREATE INDEX IF NOT EXISTS idx_gantt_tasks_ddl        ON public.gantt_tasks(ddl);
CREATE INDEX IF NOT EXISTS idx_gantt_tasks_user_start ON public.gantt_tasks(user_id, start_date);

-- 3. updated_at 自动更新触发器
CREATE OR REPLACE FUNCTION public.update_gantt_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_gantt_updated_at ON public.gantt_tasks;
CREATE TRIGGER trigger_gantt_updated_at
  BEFORE UPDATE ON public.gantt_tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.update_gantt_updated_at();

-- 4. 启用 Row Level Security
ALTER TABLE public.gantt_tasks ENABLE ROW LEVEL SECURITY;

-- 5. RLS 策略：用户只能读取自己的任务
DROP POLICY IF EXISTS "Users can view own gantt tasks" ON public.gantt_tasks;
CREATE POLICY "Users can view own gantt tasks"
  ON public.gantt_tasks
  FOR SELECT
  USING (auth.uid() = user_id);

-- 6. RLS 策略：用户只能插入自己的任务
DROP POLICY IF EXISTS "Users can insert own gantt tasks" ON public.gantt_tasks;
CREATE POLICY "Users can insert own gantt tasks"
  ON public.gantt_tasks
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- 7. RLS 策略：用户只能更新自己的任务
DROP POLICY IF EXISTS "Users can update own gantt tasks" ON public.gantt_tasks;
CREATE POLICY "Users can update own gantt tasks"
  ON public.gantt_tasks
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- 8. RLS 策略：用户只能删除自己的任务
DROP POLICY IF EXISTS "Users can delete own gantt tasks" ON public.gantt_tasks;
CREATE POLICY "Users can delete own gantt tasks"
  ON public.gantt_tasks
  FOR DELETE
  USING (auth.uid() = user_id);
