/** Preloaded examples so the app can be demonstrated without hunting for a bug. */
export interface Sample {
  label: string;
  path: string;
  content: string;
  error: string;
}

export const SAMPLES: Sample[] = [
  {
    label: "JavaScript — off-by-one",
    path: "cart.js",
    content: `function cartTotal(items) {
  let total = 0;
  // Walks one index past the end of the array.
  for (let i = 0; i <= items.length; i++) {
    total += items[i].price * items[i].quantity;
  }
  return total;
}

function applyDiscount(total, code) {
  const table = { SAVE10: 0.1, SAVE20: 0.2 };
  const rate = table[code];
  return total - total * rate;
}

module.exports = { cartTotal, applyDiscount };
`,
    error: `TypeError: Cannot read properties of undefined (reading 'price')
    at cartTotal (/srv/app/cart.js:5:22)
    at checkout (/srv/app/checkout.js:18:19)
    at processOrder (/srv/app/orders.js:42:11)
    at /srv/app/node_modules/express/lib/router/index.js:281:22`,
  },
  {
    label: "Python — mutable default",
    path: "tracker.py",
    content: `class EventTracker:
    def __init__(self, name):
        self.name = name

    def record(self, event, history=[]):
        """Append an event and return the history for this call."""
        history.append(event)
        return history


def summarise(tracker, events):
    results = []
    for i in range(len(events) + 1):
        results.append(tracker.record(events[i]))
    return results
`,
    error: `Traceback (most recent call last):
  File "/app/main.py", line 22, in <module>
    print(summarise(tracker, ["click", "scroll"]))
  File "/app/tracker.py", line 14, in summarise
    results.append(tracker.record(events[i]))
IndexError: list index out of range`,
  },
];
