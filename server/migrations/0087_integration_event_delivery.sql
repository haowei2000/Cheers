-- Which message an inbound event became.
--
-- Delivery derives the message id from the provider's own delivery id, so a
-- retry after a crash collides on `messages_pkey` instead of posting twice.
-- Recording the id here is what lets an operator walk from a GitHub delivery to
-- the message it produced without re-deriving the uuid by hand.
ALTER TABLE integration_webhook_events
    ADD COLUMN IF NOT EXISTS posted_msg_id VARCHAR(36);
