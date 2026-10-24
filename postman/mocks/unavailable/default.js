const http = require("node:http");
// Minimal Xtream wire shapes verified against ViniPlay's xtreamClient.js.
http
	.createServer((req, res) => {
		const url = new URL(req.url, "http://fixture.invalid");
		if (!url.pathname.endsWith("/player_api.php")) {
			res.writeHead(501);
			res.end();
			return;
		}
		if (
			url.searchParams.get("username") !== "fixture" ||
			url.searchParams.get("password") !== "fixture"
		) {
			res.writeHead(401);
			res.end();
			return;
		}
		const action = url.searchParams.get("action");
		const data = {
			get_live_categories: [{ category_id: "1", category_name: "TV" }],
			get_vod_categories: [{ category_id: "2", category_name: "Films" }],
			get_series_categories: [{ category_id: "3", category_name: "Shows" }],
			get_live_streams: [
				{ stream_id: 1, name: "TV fixture", category_id: "1" },
			],
			get_vod_streams: [
				{
					stream_id: 2,
					name: "Movie fixture",
					category_id: "2",
					container_extension: "mp4",
				},
			],
			get_series: [{ series_id: 3, name: "Series fixture", category_id: "3" }],
			get_series_info: {
				episodes: {
					1: [
						{
							id: "4",
							title: "Episode fixture",
							episode_num: 1,
							season: 1,
							container_extension: "mp4",
						},
					],
				},
			},
		}[action];
		if (!data) {
			res.writeHead(501);
			res.end();
			return;
		}
		res.setHeader("Content-Type", "application/json");
		res.end(JSON.stringify(data));
	})
	.listen(process.env.PORT);
