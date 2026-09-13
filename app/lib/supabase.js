import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

const createNoopChannel = () => {
  const channel = {
    on: () => channel,
    subscribe: () => channel
  };
  return channel;
};

const createNoopTable = () => {
  return {
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: null, error: { message: 'Supabase not configured' } })
      })
    }),
    insert: async () => ({ data: null, error: { message: 'Supabase not configured' } }),
    upsert: () => ({
      select: async () => ({ data: null, error: { message: 'Supabase not configured' } })
    })
  };
};

const createNoopSupabase = () => ({
  auth: {
    getSession: async () => ({ data: { session: null }, error: null }),
    onAuthStateChange: () => ({
      data: { subscription: { unsubscribe: () => {} } }
    }),
    signInWithOtp: async () => ({ data: null, error: { message: 'Supabase not configured' } }),
    signInWithOAuth: async () => ({ data: null, error: { message: 'Supabase not configured' } }),
    verifyOtp: async () => ({ data: null, error: { message: 'Supabase not configured' } }),
    signOut: async () => ({ error: null })
  },
  from: () => createNoopTable(),
  channel: () => createNoopChannel(),
  removeChannel: () => {},
  rpc: async () => ({ data: null, error: { message: 'Supabase not configured' } }),
  functions: {
    invoke: async () => ({ data: null, error: { message: 'Supabase not configured' } })
  }
});

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        // 启用自动刷新 token
        autoRefreshToken: true,
        // 持久化 session 到 localStorage
        persistSession: true,
        // 检测 URL 中的 session（用于邮箱验证回调）
        detectSessionInUrl: true
      }
    })
  : createNoopSupabase();

// ---------------------------------------------------------------------------
// 业务表访问前置条件（fund_related / fund_secid 等 RLS 仅 authenticated 可读）
// - 无登录会话时直接跳过，避免匿名查询必然返回空 + 报错
// - 服务不可达（域名无法解析 / 断网）时进入冷却熔断，避免反复发起失败请求
// ---------------------------------------------------------------------------
const SUPABASE_CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000;

let supabaseHasSession = false;
let supabaseCircuitOpenUntil = 0;

if (isSupabaseConfigured && typeof window !== 'undefined') {
  try {
    supabase.auth
      .getSession()
      .then(({ data }) => {
        supabaseHasSession = Boolean(data?.session);
      })
      .catch(() => {});
    supabase.auth.onAuthStateChange((_event, session) => {
      supabaseHasSession = Boolean(session);
    });
  } catch {}
}

/** 熔断是否处于冷却期 */
export const isSupabaseCircuitOpen = () => Date.now() < supabaseCircuitOpenUntil;

/** 标记 Supabase 服务不可达，开启冷却期（后续业务请求直接跳过） */
export const tripSupabaseCircuit = () => {
  supabaseCircuitOpenUntil = Date.now() + SUPABASE_CIRCUIT_COOLDOWN_MS;
};

/** 业务表是否可访问：已配置 + 已登录 + 未熔断 */
export const canUseSupabaseBusiness = () => isSupabaseConfigured && supabaseHasSession && !isSupabaseCircuitOpen();
