// Service Worker for Push Notifications

self.addEventListener('push', function(event) {
  if (!event.data) {
    console.log('Push event received with no data payload.');
    return;
  }

  let data = {};
  try {
    data = event.data.json();
  } catch (e) {
    console.log('Push event received with text payload:', event.data.text());
    data = {
      title: 'Alert',
      body: event.data.text(),
      url: '/'
    };
  }

  const title = data.title || 'Special Offer';
  
  const options = {
    body: data.body || 'You have a new update. Click to view.',
    icon: data.icon || '/img/logo.png',
    image: data.image || '',
    badge: data.badge || data.icon || '/img/logo.png',
    data: {
      url: data.url || '/'
    },
    // Vibrate patterns for Android devices
    vibrate: [100, 50, 100],
    actions: [
      { action: 'open', title: 'Open Link' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close(); // Close the notification popup

  // Get target redirection URL from the event payload data
  let targetUrl = '/';
  if (event.notification.data && event.notification.data.url) {
    targetUrl = event.notification.data.url;
  }

  // Open the target URL in a new window/tab
  event.waitUntil(
    clients.openWindow(targetUrl)
  );
});
