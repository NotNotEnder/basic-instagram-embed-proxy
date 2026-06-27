# Instagram Embed Proxy (For Reels)
This app will take any reel and make it an embed! All you have to do is replace the "instagram.com" with wherever your server is (or you can use mine!).

## Example
```https://instagram.com/reel/something-really-profound``` to
```https://insta.stick.moe/reel/something-really-profound```

If you have your own server, just replace ```insta.stick.moe``` with your own! If the URL is a ```/reels/``` URL... it auto-resolves too!

## Installing
Git clone the repo. ```git clone https://github.com/NotNotEnder/basic-instagram-embed-proxy```

Install Node.js dependencies. ```npm install``` or use whatever your favourite is lol, idc. And update it too!!

Make your .env. This needs to have an account cookie for it to work now! Instagram changed some stuff and now it won't auth without it. Set it with ```IG_COOKIE="sessionid=X; csrftoken=X"```.

Run the server. ```node server.js```

That's it!

## FAQ
Q: Does Instagram like this?

A: Uhhhh... probably not, but it's okay lol.


Q: Does it work with normal posts, or just reels?

A: It does not work with normal posts as of right now. I tried to get it to work, but it would just resolve a preview for some reason. I may or may not try again at some point (depends on how I feel). Feel free to try to get it to work yourself though lol.
##

Made with Claude Code (mostly).
