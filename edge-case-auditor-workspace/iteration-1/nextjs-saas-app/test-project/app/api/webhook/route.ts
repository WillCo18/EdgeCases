import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { supabaseAdmin } from '@/lib/supabase';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function POST(req: Request) {
  const body = await req.text();
  const sig = req.headers.get('stripe-signature')!;

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (err) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;

    await supabaseAdmin.from('subscriptions').insert({
      user_id: session.metadata.userId,
      stripe_customer_id: session.customer,
      stripe_subscription_id: session.subscription,
      plan: session.metadata.plan,
      status: 'active',
      current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    });
  }

  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object as Stripe.Subscription;

    await supabaseAdmin
      .from('subscriptions')
      .update({ status: 'cancelled' })
      .eq('stripe_subscription_id', subscription.id);
  }

  return NextResponse.json({ received: true });
}
