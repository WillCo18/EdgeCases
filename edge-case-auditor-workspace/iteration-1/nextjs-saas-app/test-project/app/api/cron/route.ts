import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import Stripe from 'stripe';
import { Resend } from 'resend';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const resend = new Resend(process.env.RESEND_API_KEY);

// Called by Vercel Cron every day at midnight
export async function GET(req: Request) {
  // Check for expiring subscriptions
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  const { data: expiring } = await supabaseAdmin
    .from('subscriptions')
    .select('*, users(*)')
    .lt('current_period_end', tomorrow.toISOString())
    .eq('status', 'active');

  for (const sub of expiring) {
    // Check if Stripe subscription is still active
    const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);

    if (stripeSub.status === 'active') {
      // Update local record with new period end
      await supabaseAdmin
        .from('subscriptions')
        .update({
          current_period_end: new Date(stripeSub.current_period_end * 1000).toISOString()
        })
        .eq('id', sub.id);
    } else {
      // Mark as expired and notify user
      await supabaseAdmin
        .from('subscriptions')
        .update({ status: 'expired' })
        .eq('id', sub.id);

      await resend.emails.send({
        from: 'noreply@myapp.com',
        to: sub.users.email,
        subject: 'Your subscription has expired',
        html: `<p>Hi ${sub.users.name}, your subscription has expired. Please renew to continue using the service.</p>`
      });
    }
  }

  return NextResponse.json({ checked: expiring.length });
}
