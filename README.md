The `valu-api` package enables developers to create custom iframe applications for Valu Social. It provides tools to invoke functions of registered Valu applications and subscribe to their events. With features like API versioning, event handling, and console command testing, developers can seamlessly integrate and extend functionality within the Valu Social ecosystem.

# Usage

## 1. Initialize ValuApi
On your application startup, create an instance of ValuApi and subscribe to the API_READY event. This event will be triggered only when your application is launched as an iframe within the Valu Verse application.

```javascript
import { ValuApi } from 'valu-api';

const valuApi = new ValuApi();
valuApi.current.addEventListener(ValuApi.API_READY, async (e) => {
  console.log("API IS READY!!!");
});
```

## 2. Get an API Pointer
Once the API is ready, you can create an APIPointer instance by specifying the name and version of the API you want to use. The version parameter is optional, and if omitted, the latest version will be used.

To get a pointer to the app API version 1:

```javascript
const appApi = valuApi.getApi('app', 1);
```

To use the latest version of the API:

```javascript
const appApi = valuApi.current.getApi('app');
```

## 3. Invoke API Commands
After obtaining the API pointer, you can invoke commands on the API. Here's an example of opening the text_chat on the app API:

```javascript
await appApi.run('open', 'text_chat');
```

For interacting with other APIs, like the chat API:

```javascript
const chatApi = valuApi.current.getApi('chat');
await chatApi.run('open-channel', { roomId: 'room123', propId: 'prop456' });
```

## 4. Subscribe to Events
You can subscribe to events emitted by the API. For example, if you want to listen for the app-open event:

```javascript
appApi.addEventListener('app-open', (event) => {
  console.log(event);
});
```

## 5. Run Console Commands (For Testing)
You can use the runConsoleCommand method to execute commands directly in the console environment. This method processes the output and returns a resolved promise on success or an error message if the command fails.

To run a console command, use:

```javascript
let command = 'app open text_chat';
let reply = await valuApi.current.runConsoleCommand(command);
console.log(reply);

command = 'chat open-channel roomId xz21wd31tx83kk propId 812t26xbq5424b';
reply = await valuApi.current.runConsoleCommand(command);
console.log(reply);
```

## Example Workflow
Here's an example of a simple workflow using valu-api:

```javascript
import { ValuApi } from 'valu-api';

const valuApi = new ValuApi();

// Wait for the API to be ready
valuApi.current.addEventListener(ValuApi.API_READY, async () => {
  console.log("API IS READY!!!");

  // Get API pointer
  const appApi = valuApi.current.getApi('app');

  // Run a command on the app API
  await appApi.run('open', 'text_chat');

  // Subscribe to events
  appApi.addEventListener('app-open', (event) => {
    console.log('App opened:', event);
  });

  // Run console command for testing
  let command = 'app open text_chat';
  let reply = await valuApi.current.runConsoleCommand(command);
  console.log(reply);
});
```

