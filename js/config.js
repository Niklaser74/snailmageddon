// Public runtime configuration. The Supabase publishable key is meant to be
// public: row level security on the server decides what it may do (insert
// analytics events, nothing else). Leave SUPABASE_URL empty to disable analytics.
export const APP_VERSION = '0.4.0';
export const SUPABASE_URL = 'https://zhkgsbbrxcrbwriztoxx.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_o1kZahVh9EN0j_hQjeiOWQ_FJtc-Z0n';
// Web Push (VAPID) public key; the private half lives in Supabase Vault.
export const VAPID_PUBLIC_KEY = 'BG_p9tfa6FCNA-aqH4D0fiVfn0tnvLcwVYGtoAOA6NpDi-Mv6SojFcltzXZutx6GgAenDLeEe07dXve6iUS21mI';
