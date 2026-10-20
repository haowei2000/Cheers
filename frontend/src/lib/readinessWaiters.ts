interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

export interface ReadinessWait {
  promise: Promise<void>;
  cancel: () => void;
}

/** Small cancelable registry for requests waiting on a shared authenticated socket. */
export class ReadinessWaiters {
  private readonly waiting = new Set<Waiter>();

  wait(): ReadinessWait {
    let waiter!: Waiter;
    const promise = new Promise<void>((resolve, reject) => {
      waiter = { resolve, reject };
      this.waiting.add(waiter);
    });
    return {
      promise,
      cancel: () => this.waiting.delete(waiter),
    };
  }

  release(error?: Error): void {
    const waiting = [...this.waiting];
    this.waiting.clear();
    for (const waiter of waiting) {
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
  }

  get size(): number {
    return this.waiting.size;
  }
}
