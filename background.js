var outRe = /\[author\]=fbid%3A(\d+).*\[body\]=(.*?)&message_batch/; // regex against outgoing message POST data
var inRe = /fbid:(\d+).*?\"mid\.(\d+:\w+)\".*?\"body\":\"(.*?)\",/g; // regex against incoming message json data
var inRe2= /fbid:(\d+).*?\"mid\.(\d+:\w+)\".*?\"body\":\"(.*?)\",/;

var pollInterval = 1000; // how frequently to check for new incoming messages
var keepaliveTime = 10 * (1000 / pollInterval); // how long to keepalive json streams

// State
var selfPitch = -1;
var selfGender = "";
var selfID = -1;
var resDict = {}; // keeps track of json streams for incoming messages
var recents = []; // recent ID's said, to avoid repetition

// Handles new outgoing messages
function handleRequest(req) {
	// Outgoing message
	if (req.url.indexOf("messenger.com/ajax/mercury/send_messages.php") != -1 && req.requestBody != undefined) {
		var bytes = req.requestBody.raw[0].bytes; // raw POST data
		var formData = String.fromCharCode.apply(null, new Uint8Array(bytes)); // convert to string
		var regexResult = outRe.exec(formData);

		if (regexResult != null && regexResult.length == 3) {
			var author = regexResult[1];
			selfID = author;

			var message = decodeURIComponent(regexResult[2]); // e.g. replace "%20" with " "
			console.log("(outgoing) " + author + ": " + message);

			// If this is a command, don't speak or send it.
			if (parseCommand(message)) {
				return {cancel: true};
			}
			else { // Normal message
				speak(true, author, message);
				return {cancel: false};
			}
		}
		else {
			console.log("Sent invalid message." + formData)
		}
	}
}

// Check an incoming JSON stream
function handleResponseStart(res) {
	if (res.url.indexOf("messenger.com/pull?channel=") == -1) 
		return;

	// var regexResult = urlRe.exec(res.url);
	// if (regexResult == null) return;

	var uniqueID = res.url;//regexResult[1] + "_" + regexResult[2];

	if (resDict[uniqueID] == undefined) {
		// console.log("Started new response " + res.url);
		resDict[uniqueID] = {};
		resDict[uniqueID]["url"] = res.url;
		resDict[uniqueID]["text"] = "";
		resDict[uniqueID]["length"] = 0;
		resDict[uniqueID]["keepalive"] = keepaliveTime;
		resDict[uniqueID]["messages"] = 0;
		resDict[uniqueID]["open"] = true
		resDict[uniqueID]["xhr"] = createNewXHR(res.url);
	}
	else {
		// console.log("Duplicate response ignored");
	}
}

// Closes JSON stream, start timing out stream
function handleResponseComplete(res) {
	if (res.url.indexOf("messenger.com/pull?channel=") == -1) 
		return;

	// var regexResult = urlRe.exec(res.url);
	// if (regexResult == null) return;

	var uniqueID = res.url;//regexResult[1] + "_" + regexResult[2];

	if (resDict[uniqueID] != undefined) {
		// console.log("Completed response " + res.url);
		resDict[uniqueID]["open"] = false
	}
}

// Create AJAX request
function createNewXHR(key) {
	var xhr = new XMLHttpRequest();
	xhr.open("GET", key, true);
	xhr.send();
	return xhr;
}

// Check our JSON streams for new incoming messages, if any
function checkResponses() {
	var responses = 0;
	for (var key in resDict) {
	    if (!resDict.hasOwnProperty(key)) {
	        continue;
	    }
	    var res = resDict[key];
	    // var text = res["open"] == true ? "Open" : "Closed"
	    // console.log(text + " Response: " + key + ", " + res["url"]);
	    responses++;

	    // received data from URL
	    if (res["xhr"].readyState == 4 && res["xhr"].status == 200) {
	    	var text = res["xhr"].responseText;
	    	// new data, refresh
	    	if (text != undefined && text.length > res["length"]) {
	    		parseResponse(res, text);
	    		res["length"] = text.length;
	    		res["keepalive"] = keepaliveTime;
	    	}
	    	// no new data, re-query
	    	else {
				res["xhr"] = createNewXHR(res["url"]);

				if (res["open"] == false)
	    			res["keepalive"]--;
	    	}
	    } // otherwise still waiting on response, hang on
	    else if (res["open"] == false) {
	    	res["keepalive"];
 	    }

	    // check if we need to kill this request
	    if (res["open"] == false && res["keepalive"] <= 0) {
	    	delete resDict[key];
	    }
	}

	// console.log("watching " + responses);
}

// Parses JSON stream data
function parseResponse(res, text) {
	var result = text.match(inRe);
	if (result == null) {
		return;
	}

	// Print new messages
	for (var i = 0; i < result.length; i++) {
		var obj = inRe2.exec(result[i]);
		if (obj == null) {
			console.log(text);
		}
		else {
			var author = obj[1];
			var uuid = obj[2];
			var message = obj[3];

			if (author == selfID) continue;
			if (recents.indexOf(uuid) == -1) {
				console.log("(incoming) " + author + ": " + message); 
				speak(false, author, message); 
				recents.push(uuid);
			}

			if (recents.length > 100) { 
				recents.pop();
			}
		}
	}
}

// Returns a pseudo random # from 0 to 1
function prng(seed) {
	var x = Math.sin(seed) * 10000;
    return x - Math.floor(x);
}

// Checks if this is a parsable command
function parseCommand(message) {
	if (message.indexOf("/stop") == 0) {
		console.log("received command: stop");
		chrome.tts.stop();
		return true;
	}
	else if (message.indexOf("/pitch") == 0) {
		var pitch = parseFloat(message.split(" ")[1]);
		if (typeof(pitch) != undefined && pitch > 0 && pitch <= 2.0)
			selfPitch = pitch;
		return true;
	}
	else if (message.indexOf("/gender") == 0) {
		var gender = message.split(" ")[1];
		if (gender == "male" || gender == "female")
			selfGender = gender;
		return true;
	}
	return false;
}

// Uses chrome's TTS to say  messages
function speak(self, author, message) {
	// generate pitch from 0.5 -> 1.5
	var pitch = 1 + (prng(author) - 0.5);
	var gender = prng(author + 13) > 0.5 ? "male" : "female"

	// If not set, initialize own voice
	if (self && selfPitch == -1)
		selfPitch = pitch; 
	else if (self)
		pitch = selfPitch;

	if (self && selfGender == "")
		selfGender = gender;
	else if (self)
		gender = selfGender;

	chrome.tts.speak(message, 
		{ pitch: pitch, gender: gender });
}

// Add chrome listener to new FBM HTTP requests
chrome.webRequest.onBeforeRequest.addListener(
	handleRequest, {urls: ["*://*.messenger.com/*"]}, ["blocking", "requestBody"]
	);

// Called when a FBM HTTP response starts
chrome.webRequest.onResponseStarted.addListener(
	handleResponseStart, {urls: ["*://*.messenger.com/*"]}
	);

// Called when a FBM HTTP response finishes
chrome.webRequest.onCompleted.addListener(
	handleResponseComplete, {urls: ["*://*.messenger.com/*"]}, ["responseHeaders"]
	);


setInterval(checkResponses, 1000);