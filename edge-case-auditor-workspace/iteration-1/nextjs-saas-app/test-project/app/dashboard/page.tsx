import { supabase } from '@/lib/supabase';

export default async function Dashboard() {
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return <div>Please log in</div>;
  }

  const { data: subscription } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('user_id', user.id)
    .single();

  const { data: usage } = await supabase
    .from('usage_logs')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(50);

  return (
    <div>
      <h1>Dashboard</h1>
      <div>
        <h2>Subscription</h2>
        <p>Plan: {subscription.plan}</p>
        <p>Status: {subscription.status}</p>
        <p>Renews: {new Date(subscription.current_period_end).toLocaleDateString()}</p>
      </div>
      <div>
        <h2>Recent Activity</h2>
        {usage.map((log: any) => (
          <div key={log.id}>
            <p>{log.action} — {new Date(log.created_at).toLocaleString()}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
