
import { Server, WebSocket, WebSocketServer } from "ws";
import { wsArcjet } from "./arcjet";

const matchSubcribers = new Map();

function subcribe(matchId: any, socket: any){
    if(!matchSubcribers.has(matchId)){
        matchSubcribers.set(matchId, new Set());
    }
    matchSubcribers.get(matchId).add(socket);
}

function unsubcribe(matchId: any, socket: any){
    const subscribers = matchSubcribers.get(matchId);
    if(!subscribers) return; 
    subscribers.delete(socket);
    if(subscribers.size === 0){
        matchSubcribers.delete(matchId); 
    } 
}

function cleanupSubcriptions(socket: any){
    for(const matchId of socket.subscriptions){
        unsubcribe(matchId, socket);
    }
}

function broadcastToMatch(matchId: any, payload: any){
    const subcribers = matchSubcribers.get(matchId);
    if(!subcribers || subcribers.size === 0) return;

    const message = JSON.stringify(payload);

    for(const client of subcribers){
        if(client.readyState === WebSocket.OPEN){
            client.send(message);
        }
    }
}

function handleMessage(socket: any, data: any){
    let message;
    try {
        message = JSON.parse(data);
    } catch (error) {
        sendJson(socket, {type: "error", message: "Invalid JSON"});
    } 
    if(message?.type === "subscribe" && Number.isInteger(message?.matchId)){
        subcribe(message.matchId, socket);
        socket.subscriptions.add(message?.matchId);
        sendJson(socket, {type:"subscribed", matchId: message.matchId});
        return;
    } 
    if(message?.type === "unsubscribe" && Number.isInteger(message?.matchId)){
        unsubcribe(message.matchId, socket);
        socket.subcriptions.delete(message?.matchId);
        sendJson(socket, {type:"unsubscribed", matchId: message.matchId});
        return;
    } 
}


 
function sendJson(socket: WebSocket, payload: any) {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(payload));
}

// broadcast to all :)
function broadcast(wss: WebSocketServer, payload: any) {
    for(const client of wss.clients){
        if (client.readyState !== WebSocket.OPEN) continue;
        client.send(JSON.stringify(payload));
    }
}

export function attachWebSocketServer(server: any, ){
    const wss = new WebSocketServer({server, path:"/ws", maxPayload: 1024 * 1024});

    wss.on("connection", async (socket: any, req) => {
        if(wsArcjet){
            try {
                const decision = await wsArcjet.protect(req);
                if(decision.isDenied()){
                    const code = decision.reason.isRateLimit() ? 1013 : 1008;
                    const reason = decision.reason.isRateLimit() ? "Too many requests" : "Access denied";
                    socket.close(code, reason);
                    return;
                }
            } catch (e) {
                console.error('WS Connection error', e);
                socket.close(1011, 'Server security error');
                return;
            }
        }

        // subcriptions
        socket.subscriptions = new Set();  
        socket.on('message', (data: any) => handleMessage(socket, data));
        socket.on('error', () => socket.terminate());
        socket.on('close', () => cleanupSubcriptions(socket));

        sendJson(socket, {type:"welcome"});  
    })

      function broadCastCommentary(matchId: any, comment: any){
        broadcastToMatch(matchId, {type:"commentary", data: comment});
    }

    function broadCastCreateMatch(match: any){
        broadcast(wss, {type:"match_created", data: match});
    }

    return { broadCastCreateMatch, broadCastCommentary }
}