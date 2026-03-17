import express from 'express';
import Stripe from 'stripe';
import Airtable from 'airtable';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

app.post('/webhook/stripe', express.json(), async (req, res) => {
  const event = req.body;

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    await base('Payments').create([
      {
        fields: {
          'Customer Email': session.customer_details.email,
          'Amount': session.amount_total / 100,
          'Currency': session.currency,
          'Payment ID': session.payment_intent,
          'Status': 'completed',
          'Date': new Date().toISOString()
        }
      }
    ]);

    console.log(`Payment synced for ${session.customer_details.email}`);
  }

  if (event.type === 'customer.subscription.created') {
    const subscription = event.data.object;
    const customer = await stripe.customers.retrieve(subscription.customer);

    await base('Subscriptions').create([
      {
        fields: {
          'Customer Email': customer.email,
          'Plan': subscription.items.data[0].price.nickname,
          'Status': subscription.status,
          'Start Date': new Date(subscription.start_date * 1000).toISOString(),
          'Subscription ID': subscription.id
        }
      }
    ]);
  }

  res.json({ received: true });
});

app.get('/sync/payments', async (req, res) => {
  const payments = await stripe.paymentIntents.list({ limit: 100 });

  for (const payment of payments.data) {
    if (payment.status === 'succeeded') {
      await base('Payments').create([
        {
          fields: {
            'Payment ID': payment.id,
            'Amount': payment.amount / 100,
            'Currency': payment.currency,
            'Status': 'completed',
            'Date': new Date(payment.created * 1000).toISOString()
          }
        }
      ]);
    }
  }

  res.json({ synced: payments.data.length });
});

app.listen(3000, () => console.log('Webhook server running on port 3000'));
