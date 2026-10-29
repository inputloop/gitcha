<!-- SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors -->
<!-- SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st> -->
<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->
# tiny-logger

Leveled, timestamped console logging with **zero dependencies**.

## Install

```
gitcha install tiny-logger
```

## Usage

```js
import { createLogger } from './gitcha_modules/tiny-logger/src/index.js';

const log = createLogger({ name: 'api', level: 'debug' });
log.info('server started on port %d', 8080);
log.warn('cache miss');
```

## Levels

- `debug`: verbose diagnostics
- `info`: normal operation (default)
- `warn`: something looks off
- `error`: something failed
