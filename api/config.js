export default function handler(req, res) {
  res.json({ stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null });
}
