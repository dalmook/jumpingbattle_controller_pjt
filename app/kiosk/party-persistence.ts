export type PartyPersistenceStatus = "pending" | "done" | "failed" | "cancelled";

export type PartyPersistenceTicket = {
  generation: number;
  inputKey: string;
  revision: number;
  status: PartyPersistenceStatus;
  error: Error | null;
  promise: Promise<void>;
};

type PartyPersistenceTaskContext = {
  signal: AbortSignal;
  isGenerationActive: () => boolean;
  isLatest: () => boolean;
};

type PartyPersistenceTask = {
  generation: number;
  inputKey: string;
  revision: number;
  execute: (context: PartyPersistenceTaskContext) => Promise<void>;
  onDone?: () => void;
  onFailed?: (error: Error) => void;
};

function asError(reason: unknown) {
  return reason instanceof Error ? reason : new Error("인원과 필수 안내를 저장하지 못했습니다.");
}

function isAbortError(reason: unknown) {
  return reason instanceof Error && reason.name === "AbortError";
}

export function createPartyPersistenceCoordinator(initialGeneration = 0) {
  let activeGeneration = initialGeneration;
  let current: PartyPersistenceTicket | null = null;
  let activeController: AbortController | null = null;
  let tail: Promise<void> = Promise.resolve();

  const isGenerationActive = (generation: number) => generation === activeGeneration;

  function enqueue(task: PartyPersistenceTask) {
    if (!isGenerationActive(task.generation)) {
      throw new Error("PARTY_PERSISTENCE_GENERATION_MISMATCH");
    }
    if (current
      && current.generation === task.generation
      && current.inputKey === task.inputKey
      && !["failed", "cancelled"].includes(current.status)) {
      return current;
    }

    const ticket: PartyPersistenceTicket = {
      generation: task.generation,
      inputKey: task.inputKey,
      revision: task.revision,
      status: "pending",
      error: null,
      promise: Promise.resolve(),
    };
    const previous = tail;
    const run = previous.catch(() => undefined).then(async () => {
      if (!isGenerationActive(ticket.generation)) {
        ticket.status = "cancelled";
        return;
      }
      const controller = new AbortController();
      activeController = controller;
      try {
        await task.execute({
          signal: controller.signal,
          isGenerationActive: () => isGenerationActive(ticket.generation) && !controller.signal.aborted,
          isLatest: () => current === ticket && isGenerationActive(ticket.generation) && !controller.signal.aborted,
        });
        if (!isGenerationActive(ticket.generation) || controller.signal.aborted || current !== ticket) {
          ticket.status = "cancelled";
          return;
        }
        ticket.status = "done";
        task.onDone?.();
      } catch (reason) {
        if (!isGenerationActive(ticket.generation) || controller.signal.aborted || isAbortError(reason)) {
          ticket.status = "cancelled";
          return;
        }
        ticket.status = "failed";
        ticket.error = asError(reason);
        if (current === ticket) task.onFailed?.(ticket.error);
      } finally {
        if (activeController === controller) activeController = null;
      }
    });
    ticket.promise = run;
    current = ticket;
    tail = run;
    return ticket;
  }

  async function wait() {
    for (;;) {
      const pending = current;
      if (!pending || !isGenerationActive(pending.generation)) return;
      await pending.promise;
      if (pending !== current) continue;
      if (pending.status === "done") return;
      if (pending.status === "failed") throw pending.error ?? new Error("인원과 필수 안내를 저장하지 못했습니다.");
      if (pending.status === "cancelled") throw new Error("진행 중인 입력이 취소되었습니다. 인원 화면에서 다시 확인해주세요.");
    }
  }

  function reset(nextGeneration: number) {
    activeGeneration = nextGeneration;
    activeController?.abort();
    activeController = null;
    if (current) current.status = "cancelled";
    current = null;
    tail = Promise.resolve();
  }

  return {
    enqueue,
    wait,
    reset,
    peek: () => current,
  };
}

export function runPartyTransitionFirst<T>({
  applyLocal,
  transition,
  enqueue,
}: {
  applyLocal: () => void;
  transition: () => void;
  enqueue: () => T;
}) {
  applyLocal();
  transition();
  return enqueue();
}
