export const SENSITIVITY_RANK = {
    public: 0,
    user: 1,
    internal: 2,
    sensitive: 3,
    restricted: 4,
};
export function isClearedToConsume(clearance, event) {
    return SENSITIVITY_RANK[event.sensitivity] <= SENSITIVITY_RANK[clearance.upTo];
}
export class InMemoryEventBus {
    #handlers = [];
    async publish(event) {
        for (const registered of this.#handlers) {
            if (isClearedToConsume(registered.clearance, event)) {
                await registered.handler(event);
            }
        }
    }
    subscribe(clearance, handler) {
        this.#handlers.push({ clearance, handler });
        return () => {
            this.#handlers = this.#handlers.filter((h) => h.handler !== handler);
        };
    }
}
//# sourceMappingURL=domain-event.js.map