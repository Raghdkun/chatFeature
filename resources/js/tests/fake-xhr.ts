/** A hand-driven `XMLHttpRequest` for upload tests: the test decides when progress arrives and how the server answers. */
export class FakeXhr {
    static instances: FakeXhr[] = [];
    static get last(): FakeXhr {
        return FakeXhr.instances[FakeXhr.instances.length - 1];
    }
    static reset(): void {
        FakeXhr.instances = [];
    }

    method = '';
    url = '';
    headers: Record<string, string> = {};
    sent: FormData | null = null;
    status = 0;
    responseText = '';
    aborted = false;
    upload: {
        onprogress:
            | ((event: {
                  lengthComputable: boolean;
                  loaded: number;
                  total: number;
              }) => void)
            | null;
    } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;

    constructor() {
        FakeXhr.instances.push(this);
    }

    open(method: string, url: string): void {
        this.method = method;
        this.url = url;
    }

    setRequestHeader(name: string, value: string): void {
        this.headers[name] = value;
    }

    send(form: FormData): void {
        this.sent = form;
    }

    abort(): void {
        this.aborted = true;
        this.onabort?.();
    }

    progress(loaded: number, total: number): void {
        this.upload.onprogress?.({ lengthComputable: true, loaded, total });
    }

    reply(status: number, body: unknown): void {
        this.status = status;
        this.responseText = JSON.stringify(body);
        this.onload?.();
    }
}
