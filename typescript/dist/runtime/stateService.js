export class StateService {
    state = {};
    set(key, value) {
        this.state[key] = value;
    }
    get(key) {
        return this.state[key];
    }
    snapshot() {
        return { ...this.state };
    }
}
